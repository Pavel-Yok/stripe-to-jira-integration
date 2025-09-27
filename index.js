const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Jira custom field IDs
const FIELD_START_DATE = 'customfield_10015';
const FIELD_SOURCE = 'customfield_10260';
const FIELD_CUSTOMER_TYPE = 'customfield_10291'; // New Customer Type field
const SOURCE_VALUE = 'Stripe'; // Value to set for the Work Source label
// CRITICAL JSM ID: This is the numeric Request Type ID required by the JSM API (e.g., 47 for 'SUBMIT A TASK')
const JSM_REQUEST_TYPE_ID = process.env.JIRA_JSM_REQUEST_TYPE_ID || '47';

/**
 * Generic Jira POST helper with detailed logging
 */
async function jiraPost(url, payload, headers, logMessage) {
    console.log(`⚡ ${logMessage} [${url}]`);
    try {
        const res = await axios.post(url, payload, { headers });
        console.log(`✅ Success: ${logMessage}`);
        return res.data;
    } catch (err) {
        console.error(`❌ Failed: ${logMessage} [${url}]`);
        if (err.response) {
            // Log the detailed error response from Jira, which often indicates the field problem
            console.error('Status:', err.response.status);
            console.error('Response:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Error:', err.message);
        }
        throw err;
    }
}

/**
 * Search for accountId with retries (handles Jira indexing lag)
 */
async function getJiraAccountIdByEmail(email, jiraDomain, headers, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await axios.get(
                `${jiraDomain}/rest/api/3/user/search?query=${encodeURIComponent(email)}`,
                { headers }
            );
            if (res.data && res.data.length > 0) {
                const accountId = res.data[0].accountId;
                console.log(`✅ Found accountId for ${email}: ${accountId} (attempt ${attempt})`);
                return accountId;
            }
            console.warn(`⚠️ Attempt ${attempt}: No Jira accountId yet for ${email}`);
        } catch (err) {
            console.error(`❌ Attempt ${attempt} failed for ${email}:`, err.response?.data || err.message);
        }
        if (attempt < retries) {
            await new Promise(res => setTimeout(res, 1500)); // wait 1.5s before retry
        }
    }
    return null;
}

/**
 * Create or skip JSM customer, then send invite email by adding to the desk
 * @returns {{accountId: string | null, wasNewCustomer: boolean}} 
 */
async function checkAndInviteCustomer(email, name, headers, jiraDomain, jsmServiceDeskId) {
    let accountId = null;
    let wasNewCustomer = false;

    // Step 1: Create or get the customer account
    try {
        const res = await jiraPost(
            `${jiraDomain}/rest/servicedeskapi/customer`,
            { email, displayName: name },
            headers,
            `Creating customer ${email}`
        );
        accountId = res.accountId || null;
        if (accountId) {
            console.log(`✅ Got accountId from creation response: ${accountId}`);
        }
        wasNewCustomer = true; // Creation successful, so user is new
    } catch (err) {
        const errorMessage = err.response?.data?.errorMessage || '';
        const alreadyExists =
            err.response?.status === 409 ||
            errorMessage.includes('already exists');
        if (alreadyExists) {
            console.log(`✅ Customer ${email} already exists.`);
        } else {
            throw err;
        }
    }

    // Step 2: If accountId is still missing (i.e., user existed), search with retries
    if (!accountId) {
        accountId = await getJiraAccountIdByEmail(email, jiraDomain, headers, 3);
    }

    if (!accountId) {
        console.warn(`⚠️ Still no accountId for ${email}, skipping invite.`);
        return { accountId: null, wasNewCustomer: false };
    }

    // Step 3: Add to service desk (triggers invite/welcome email)
    try {
        await jiraPost(
            `${jiraDomain}/rest/servicedeskapi/servicedesk/${jsmServiceDeskId}/customer`,
            { accountIds: [accountId] },
            headers,
            `Adding customer ${email} to JSM desk ${jsmServiceDeskId}`
        );
        console.log(`✅ Customer added to JSM desk ${jsmServiceDeskId}.`);
        console.log(`📨 Invite email triggered for ${email}`);
    } catch (err) {
        const alreadyAdded = err.response?.status === 400 ||
            (err.response?.data?.errorMessage || '').includes('already belongs to');
        if (alreadyAdded) {
            console.log(`✅ Customer ${email} already in JSM desk ${jsmServiceDeskId}. Skipping.`);
        } else {
            throw err;
        }
    }
    return { accountId, wasNewCustomer };
}

/**
 * Build Atlassian Document Format (ADF) for description
 */
function buildCustomerDescriptionDoc(customerData, startDate, endDate) {
    return `
Customer: ${customerData.name}
Email: ${customerData.email}
Phone: ${customerData.phone}
Company Address: ${customerData.address}
Amount Paid: ${customerData.amount}
Start Date: ${startDate}
End Date: ${endDate}
`;
}

/**
 * Create JSM Customer Request (uses JSM API)
 */
async function createJsmCustomerRequest(summary, jsmProjectKey, jiraDomain, headers, customerData, startDate, endDate, wasNewCustomer) {
    const sourceFieldPayload = [SOURCE_VALUE]; 
    
    // Determine the label for Customer Type: 'New-Customer' or 'Existing_Customer'
    const customerTypeLabel = wasNewCustomer ? ['New-Customer'] : ['Existing-Customer'];

    // The fields below are CONFIRMED available in the createmeta response.
    const requestFields = {
        "summary": summary,
        "description": buildCustomerDescriptionDoc(customerData, startDate, endDate),
        [FIELD_START_DATE]: startDate,
        "duedate": endDate,
        [FIELD_SOURCE]: sourceFieldPayload,
        [FIELD_CUSTOMER_TYPE]: customerTypeLabel 
    };

    return jiraPost(
        `${jiraDomain}/rest/servicedeskapi/request`,
        {
            serviceDeskId: process.env.JIRA_JSM_SERVICE_DESK_ID,
            requestTypeId: JSM_REQUEST_TYPE_ID,
            raiseOnBehalfOf: customerData.email, 
            requestFieldValues: requestFields
        },
        headers,
        'Creating JSM customer request'
    );
}

/**
 * Orchestrator: process checkout session
 */
async function processCheckoutSession(session) {
    console.log("📝 Session metadata:", session.metadata);
    const metadata = session.metadata || {};
    const customerDetails = session.customer_details || {};

    // Metadata
    const jsmProjectKey = metadata.jsmProjectKey?.toUpperCase() || process.env.JIRA_JSM_PROJECT_KEY;
    const jsmServiceDeskId = metadata.jsmServiceDeskId || process.env.JIRA_JSM_SERVICE_DESK_ID;
    const summary = metadata.summary || 'New Support Request';
    const durationDays = parseInt(metadata.duration || '5', 10);
    const amountPaid = (session.amount_total || 0) / 100;
    const currency = session.currency?.toUpperCase() || 'EUR';

    // Customer
    const customerEmail = customerDetails.email;
    const customerName = customerDetails.name || 'N/A';
    const phone = customerDetails.phone || 'N/A';
    const address = customerDetails.address || {};
    const companyAddress = [address.line1, address.city, address.postal_code, address.country].filter(Boolean).join(', ') || 'N/A';

    const customerData = {
        name: customerName,
        email: customerEmail,
        phone,
        address: companyAddress,
        amount: `${amountPaid.toFixed(2)} ${currency}`
    };

    // Dates
    const now = new Date();
    const startDate = now.toISOString().split('T')[0];
    const endDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Jira setup
    const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
    const jiraDomain = process.env.JIRA_DOMAIN;
    const headers = {
        'Authorization': `Basic ${jiraAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };
    console.log("🔍 Jira Domain:", jiraDomain);

    try {
        // 1️⃣ Onboard customer + invite
        let wasNewCustomer = false;
        let accountId = null;

        if (jsmProjectKey && jsmServiceDeskId) {
            const result = await checkAndInviteCustomer(customerEmail, customerName, headers, jiraDomain, jsmServiceDeskId);
            
            if (result && result.accountId) {
                accountId = result.accountId;
                wasNewCustomer = result.wasNewCustomer;
                console.log(wasNewCustomer ? "🌟 New customer detected." : "👤 Existing customer detected.");
            } else {
                console.warn("⚠️ Could not determine customer type — skipping customer type label.");
            }
        } else {
            console.warn("⚠️ Skipping JSM onboarding — missing jsmProjectKey or jsmServiceDeskId.");
        }

        // 2️⃣ Reporter: The JSM API handles attribution via raiseOnBehalfOf.
        // The reporterObject is NOT USED here.
        // const reporterObject = accountId ? { accountId } : { emailAddress: customerEmail }; 

        // 3️⃣ Create Customer Request (uses JSM API)
        if (jsmProjectKey) {
            // Note: The null argument for reporterObject is removed, as it's not used in this function
            await createJsmCustomerRequest(summary, jsmProjectKey, jiraDomain, headers, customerData, startDate, endDate, wasNewCustomer);
        }
    } catch (err) {
        console.error('❌ Jira workflow failed completely');
        if (err.response) {
            console.error('Status:', err.response.status);
            console.error('Response:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Error:', err.message);
        }
    }
}

/**
 * Main Cloud Function handler
 */
exports.stripetojira = async (req, res) => {
    if (!req.rawBody) {
        console.error("❌ Missing rawBody on request");
        return res.status(400).send("Webhook Error: Missing raw body");
    }

    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
        console.log(`✅ Event verified: ${event.type}`);
    } catch (err) {
        console.error("❌ Webhook signature verification failed:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    res.status(200).send("Event received");
    console.log("⚡ Response sent to Stripe");

    if (event.type === 'checkout.session.completed') {
        processCheckoutSession(event.data.object).catch(err => {
            console.error(`❌ Failed to process event ${event.id}:`, err);
        });
    } else {
        console.log(`ℹ️ Ignored event type: ${event.type}`);
    }
};
