const axios = require('axios');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Jira custom field IDs (✅ real ones from your instance)
const FIELD_EPIC_NAME = 'customfield_10011';
const FIELD_EPIC_LINK = 'customfield_10014';
const FIELD_START_DATE = 'customfield_10015';
const jsmIssueTypeId = process.env.JIRA_JSM_ISSUE_TYPE_ID || '10018'; // Using ID for stability

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
 * Create or skip JSM customer
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
        const errorMessage = err.response?.data?.errorMessage || '';
        const alreadyExists =
            err.response?.status === 409 ||
            errorMessage.includes('already exists');
        if (alreadyExists) {
            console.log(`✅ Customer ${email} already exists. Skipping creation.`);
        } else {
            console.error(`❌ Unexpected error inviting ${email}:`, err.response?.data || err.message);
        }
    }
}

/**
 * Explicitly send JSM invite email
 * NOTE: This function is not used in Cloud. It is kept here for reference.
 * The checkAndInviteCustomer function already sends the welcome email.
 */
async function sendCustomerInvite(email, jsmServiceDeskId, headers, jiraDomain) {
    console.log(`❌ Skipped sendCustomerInvite - This is not needed in Jira Cloud.`);
}

/**
 * Resolve Jira accountId from email
 */
async function getJiraAccountIdByEmail(email, jiraDomain, headers) {
    if (!email) return null;
    try {
        const res = await axios.get(
            `${jiraDomain}/rest/api/3/user/search?query=${encodeURIComponent(email)}`,
            { headers }
        );
        if (res.data && res.data.length > 0) {
            console.log(`✅ Found Jira accountId for ${email}`);
            return res.data[0].accountId;
        }
        console.warn(`⚠️ No Jira accountId found for ${email}`);
        return null;
    } catch (err) {
        console.error(`❌ Failed to fetch Jira accountId for ${email}:`, err.response?.data || err.message);
        return null;
    }
}

/**
 * Build Atlassian Document Format (ADF) for customer description
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
 * Create Jira Software Epic + Task
 */
async function createJiraSoftwareWork(jiraSoftwareProjectKey, summary, issueType, reporterObject, customerData, jiraDomain, headers, startDate, endDate) {
    const epic = await jiraPost(
        `${jiraDomain}/rest/api/3/issue`,
        {
            fields: {
                project: { key: jiraSoftwareProjectKey },
                summary: 'New Client',
                issuetype: { name: 'Epic' },
                [FIELD_EPIC_NAME]: 'New Client'
            }
        },
        headers,
        'Creating Epic'
    );

    const task = await jiraPost(
        `${jiraDomain}/rest/api/3/issue`,
        {
            fields: {
                project: { key: jiraSoftwareProjectKey },
                summary,
                issuetype: { name: issueType },
                description: buildCustomerDescriptionDoc(customerData, startDate, endDate),
                [FIELD_START_DATE]: startDate,
                duedate: endDate,
                [FIELD_EPIC_LINK]: epic.key,
                reporter: reporterObject
            }
        },
        headers,
        'Creating Task'
    );

    return task.key;
}

/**
 * Create JSM Support Request
 */
async function createJsmSupportTicket(summary, jsmProjectKey, jiraDomain, headers, reporterObject, customerName, customerEmail, amountPaid, currency) {
    return jiraPost(
        `${jiraDomain}/rest/api/3/issue`,
        {
            fields: {
                project: { key: jsmProjectKey },
                summary: `Support Request for ${summary}`,
                issuetype: { id: jsmIssueTypeId },
                description: {
                    type: "doc",
                    version: 1,
                    content: [
                        { type: "paragraph", content: [{ type: "text", text: `A new support request has been submitted by the customer.` }] },
                        { type: "paragraph", content: [{ type: "text", text: `Customer: ${customerName}` }] },
                        { type: "paragraph", content: [{ type: "text", text: `Email: ${customerEmail}` }] },
                        { type: "paragraph", content: [{ type: "text", text: `Amount Paid: ${amountPaid.toFixed(2)} ${currency}` }] }
                    ]
                },
                reporter: reporterObject
            }
        },
        headers,
        'Creating JSM support request'
    );
}

/**
 * Create JSM Order Confirmation linked to Jira Software task
 */
async function createJsmOrderConfirmation(summary, taskKey, jsmProjectKey, jiraDomain, headers, reporterObject) {
    return jiraPost(
        `${jiraDomain}/rest/api/3/issue`,
        {
            fields: {
                project: { key: jsmProjectKey },
                summary: `Order received for "${summary}"`,
                issuetype: { id: jsmIssueTypeId },
                description: {
                    type: "doc",
                    version: 1,
                    content: [
                        { type: "paragraph", content: [{ type: "text", text: `Your order has been received. Our team has created an internal task to begin work.` }] },
                        { type: "paragraph", content: [{ type: "text", text: `Internal Task: ${jiraDomain}/browse/${taskKey}` }] }
                    ]
                },
                reporter: reporterObject
            }
        },
        headers,
        'Creating JSM order confirmation'
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
    const jiraSoftwareProjectKey = metadata.project?.toUpperCase() || null;
    const jsmProjectKey = metadata.jsmProjectKey?.toUpperCase() || process.env.JIRA_JSM_PROJECT_KEY;
    const jsmServiceDeskId = metadata.jsmServiceDeskId || process.env.JIRA_JSM_SERVICE_DESK_ID;
    const issueType = metadata.issue || 'Task';
    const summary = metadata.summary || 'New Task';
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
        // 1️⃣ Onboard customer (this also sends the welcome email)
        if (jsmProjectKey) {
            await checkAndInviteCustomer(customerEmail, customerName, headers, jiraDomain);
        } else {
            console.warn("⚠️ Skipping JSM onboarding — missing jsmProjectKey.");
        }

        // 2️⃣ Reporter
        const jiraAccountId = await getJiraAccountIdByEmail(customerEmail, jiraDomain, headers);
        const reporterObject = jiraAccountId ? { accountId: jiraAccountId } : { emailAddress: customerEmail };

        // 3️⃣ Workflows
        if (issueType.toLowerCase() === 'support' && jsmProjectKey) {
            await createJsmSupportTicket(summary, jsmProjectKey, jiraDomain, headers, reporterObject, customerName, customerEmail, amountPaid, currency);
        } else if (jiraSoftwareProjectKey) {
            const taskKey = await createJiraSoftwareWork(jiraSoftwareProjectKey, summary, issueType, reporterObject, customerData, jiraDomain, headers, startDate, endDate);
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
