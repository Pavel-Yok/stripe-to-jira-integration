const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Use named constants for Jira custom fields
const FIELD_EPIC_NAME = 'customfield_10011';
const FIELD_EPIC_LINK = 'customfield_10014';
const FIELD_START_DATE = 'customfield_10015';

/**
 * Helper: find Jira accountId by email
 */
async function getJiraAccountIdByEmail(email, jiraDomain, headers) {
    if (!email) {
        console.warn("⚠️ No email provided, cannot resolve accountId.");
        return null;
    }
    try {
        const res = await axios.get(
            `${jiraDomain}/rest/api/3/user/search?query=${encodeURIComponent(email)}`,
            { headers }
        );
        if (res.data && res.data.length > 0) {
            console.log(`✅ Found Jira accountId for ${email}`);
            return res.data[0].accountId;
        }
        console.warn(`⚠️ No Jira accountId found for email: ${email}`);
        return null;
    } catch (err) {
        console.error('❌ Error fetching Jira accountId:', err.response?.data || err.message);
        return null;
    }
}

/**
 * Helper: check and invite a customer to the JSM portal (with graceful error handling)
 */
async function checkAndInviteCustomer(email, name, headers, jiraDomain) {
    try {
        await jiraPost(
            `${jiraDomain}/rest/servicedeskapi/customer`,
            { email, displayName: name },
            headers,
            `Inviting customer ${email}`
        );
    } catch (err) {
        // Handle "user already exists" errors gracefully.
        const errorMessages = err.response?.data?.errorMessages;
        const isUserExistsError =
            err.response?.status === 409 ||
            (Array.isArray(errorMessages) && errorMessages.some(msg => msg.includes("already exists"))) ||
            (err.response?.data?.errorMessage?.includes("An account already exists for this email"));

        if (isUserExistsError) {
            console.log(`✅ Customer ${email} already exists. Skipping invitation.`);
        } else {
            console.error(`❌ Unexpected error inviting ${email}:`, err.response?.data || err.message);
        }
    }
}

/**
 * Helper: explicitly send an invite email to a JSM customer
 */
async function sendCustomerInvite(email, jsmProjectKey, headers, jiraDomain) {
    try {
        await jiraPost(
            `${jiraDomain}/rest/servicedeskapi/servicedesk/${jsmProjectKey}/customer/invite`,
            {
                emails: [email]   // <-- correct field name
            },
            headers,
            `Sending invite email to ${email}`
        );
    } catch (err) {
        console.error(`❌ Failed to send invite to ${email}`);
        if (err.response) {
            console.error('Status:', err.response.status);
            console.error('Response:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Error:', err.message);
        }
    }
}

/**
 * Unified helper for Jira API POST requests with logging
 */
async function jiraPost(url, payload, headers, actionDesc) {
    try {
        const res = await axios.post(url, payload, { headers });
        console.log(`✅ Success: ${actionDesc} [${url}]`);
        return res.data;
    } catch (err) {
        console.error(`❌ Failed: ${actionDesc} [${url}]`);
        if (err.response) {
            console.error('Status:', err.response.status);
            console.error('Response:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Error:', err.message);
        }
        throw err;
    }
}

/**
 * Orchestration: Process a completed checkout session
 */
async function processCheckoutSession(session) {
    console.log("📝 Session metadata:", session.metadata);
    const metadata = session.metadata || {};
    const customerDetails = session.customer_details || {};

    // Metadata mapping
    const jiraSoftwareProjectKey = metadata.project?.toUpperCase() || null;
    const jsmProjectKey = metadata.jsmProjectKey?.toUpperCase() || process.env.JIRA_JSM_PROJECT_KEY;
    const jsmServiceDeskId = metadata.jsmServiceDeskId || process.env.JIRA_JSM_SERVICE_DESK_ID;
    const issueType = metadata.issue || 'Task';
    const summary = metadata.summary || 'New Task';
    const durationDays = parseInt(metadata.duration || '5', 10);
    const amountPaid = (session.amount_total || 0) / 100;
    const currency = session.currency?.toUpperCase() || 'EUR';

    // Customer details
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
    console.log("🔍 Jira Domain:", jiraDomain);
    const headers = {
        'Authorization': `Basic ${jiraAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    try {
        // 1️⃣ Customer-facing: Onboard first
        if (jsmProjectKey && jsmServiceDeskId) {
            await checkAndInviteCustomer(customerEmail, customerName, headers, jiraDomain);
            console.log(`📨 Attempting to send invite to ${customerEmail} for JSM desk ${jsmServiceDeskId}...`);
            await sendCustomerInvite(customerEmail, jsmServiceDeskId, headers, jiraDomain);
        } else {
            console.warn("⚠️ Skipping JSM onboarding — missing jsmProjectKey or jsmServiceDeskId.");
        }

        // 2️⃣ Shared setup: Reporter
        const jiraAccountId = await getJiraAccountIdByEmail(customerEmail, jiraDomain, headers);
        const reporterObject = jiraAccountId ? { accountId: jiraAccountId } : { emailAddress: customerEmail };

        // 3️⃣ Workflows
        if (issueType.toLowerCase() === 'support' && jsmProjectKey) {
            // JSM support request
            await createJsmSupportTicket(
                summary, jsmProjectKey, jiraDomain, headers,
                reporterObject, customerName, customerEmail, amountPaid, currency
            );
        } else if (jiraSoftwareProjectKey) {
            // Jira Software work
            const taskKey = await createJiraSoftwareWork(
                jiraSoftwareProjectKey, summary, issueType, reporterObject,
                customerData, jiraDomain, headers, startDate, endDate
            );

            // JSM order confirmation (linked to task)
            if (jsmProjectKey) {
                await createJsmOrderConfirmation(summary, taskKey, jsmProjectKey, jiraDomain, headers, reporterObject);
            }
        } else {
            console.warn("⚠️ No Jira Software project key available. Skipping Software + Order Confirmation flow.");
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
 * Main Cloud Function handler.
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
        console.error('❌ Webhook signature verification failed:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    res.status(200).send('Event received');
    console.log("⚡ Response sent to Stripe");

    if (event.type === 'checkout.session.completed') {
        processCheckoutSession(event.data.object).catch(err => {
            console.error(`❌ Failed to process event ${event.id}:`, err);
        });
    } else {
        console.log(`ℹ️ Ignored event type: ${event.type}`);
    }
};
