const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Jira custom field IDs
const FIELD_START_DATE = 'customfield_10015';
const jsmIssueTypeId = process.env.JIRA_JSM_ISSUE_TYPE_ID || '10018'; // Support

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
            console.error('Status:', err.response.status);
            console.error('Response:', JSON.stringify(err.response.data, null, 2));
        } else {
            console.error('Error:', err.message);
        }
        throw err;
    }
}

/**
 * Create or skip JSM customer, then send invite email
 */
async function checkAndInviteCustomer(email, name, headers, jiraDomain, jsmServiceDeskId) {
    // Step 1: Create or get the customer account
    try {
        await jiraPost(
            `${jiraDomain}/rest/servicedeskapi/customer`,
            { email, displayName: name },
            headers,
            `Creating customer ${email}`
        );
    } catch (err) {
        const errorMessage = err.response?.data?.errorMessage || '';
        const alreadyExists =
            err.response?.status === 409 ||
            errorMessage.includes('already exists');
        if (alreadyExists) {
            console.log(`✅ Customer ${email} already exists. Skipping creation.`);
        } else {
            console.error(`❌ Unexpected error creating customer ${email}:`, err.response?.data || err.message);
            throw err;
        }
    }

    // Step 2: Add customer to the specific service desk (this sends the email)
    // This call will fail if the customer is already part of the service desk.
    try {
        await jiraPost(
            `${jiraDomain}/rest/servicedeskapi/servicedesk/${jsmServiceDeskId}/customer`,
            { emailAddresses: [email] },
            headers,
            `Adding customer ${email} to JSM desk ${jsmServiceDeskId}`
        );
        console.log(`📨 Invite email sent to ${email}`);
    } catch (err) {
        // Refined error handling: only treat 409 or a specific message as "already added"
        const alreadyAdded = err.response?.status === 409 ||
            (err.response?.data?.errorMessage || '').includes('already belongs to');
        if (alreadyAdded) {
            console.log(`✅ Customer ${email} already added to JSM desk ${jsmServiceDeskId}. Skipping.`);
        } else {
            console.error(`❌ Unexpected error adding customer to JSM desk ${jsmServiceDeskId}:`, err.response?.data || err.message);
            throw err;
        }
    }
}

/**
 * Build Atlassian Document Format (ADF) for description
 */
function buildCustomerDescriptionDoc(customerData, startDate, endDate) {
    return {
        type: "doc",
        version: 1,
        content: [
            { type: "paragraph", content: [{ type: "text", text: `Customer: ${customerData.name}` }] },
            { type: "paragraph", content: [{ type: "text", text: `Email: ${customerData.email}` }] },
            { type: "paragraph", content: [{ type: "text", text: `Phone: ${customerData.phone}` }] },
            { type: "paragraph", content: [{ type: "text", text: `Company Address: ${customerData.address}` }] },
            { type: "paragraph", content: [{ type: "text", text: `Amount Paid: ${customerData.amount}` }] },
            { type: "paragraph", content: [{ type: "text", text: `Start Date: ${startDate}` }] },
            { type: "paragraph", content: [{ type: "text", text: `End Date: ${endDate}` }] }
        ]
    };
}

/**
 * Create JSM Support Request
 */
async function createJsmSupportTicket(summary, jsmProjectKey, jiraDomain, headers, reporterObject, customerData, startDate, endDate) {
    return jiraPost(
        `${jiraDomain}/rest/api/3/issue`,
        {
            fields: {
                project: { key: jsmProjectKey },
                summary: `Support Request for ${summary}`,
                issuetype: { id: jsmIssueTypeId }, // Always "Support"
                description: buildCustomerDescriptionDoc(customerData, startDate, endDate),
                [FIELD_START_DATE]: startDate,
                duedate: endDate,
                reporter: reporterObject
            }
        },
        headers,
        'Creating JSM support request'
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
        if (jsmProjectKey && jsmServiceDeskId) {
            await checkAndInviteCustomer(customerEmail, customerName, headers, jiraDomain, jsmServiceDeskId);
        } else {
            console.warn("⚠️ Skipping JSM onboarding — missing jsmProjectKey or jsmServiceDeskId.");
        }

        // 2️⃣ Reporter (optional — use Jira accountId if exists)
        const reporterObject = { emailAddress: customerEmail };

        // 3️⃣ Always create Support issue
        if (jsmProjectKey) {
            await createJsmSupportTicket(summary, jsmProjectKey, jiraDomain, headers, reporterObject, customerData, startDate, endDate);
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
