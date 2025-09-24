const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const express = require('express');
const app = express();

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

// Use named constants for Jira custom fields
const FIELD_EPIC_NAME = 'customfield_10011';
const FIELD_EPIC_LINK = 'customfield_10014';
const FIELD_START_DATE = 'customfield_10015';

// Helper function to check and invite a customer to the JSM portal
async function checkAndInviteCustomer(email, name, jsmProjectKey, headers, jiraDomain) {
    try {
        await axios.post(`${jiraDomain}/rest/servicedesk/1/customer`, {
            email: email,
            displayName: name,
            projects: [jsmProjectKey]
        }, { headers });
        console.log(`Successfully invited customer: ${email} to JSM portal.`);
    } catch (err) {
        // A 409 Conflict status code means the user already exists
        if (err.response?.status === 409) {
            console.log(`Customer ${email} already exists in JSM portal.`);
        } else {
            console.error('Error inviting customer to JSM portal:', err.response?.data || err.message);
            throw new Error('Failed to invite customer to JSM portal.');
        }
    }
}

app.post('/stripetojira', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
        console.error('Webhook signature verification failed.', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type !== 'checkout.session.completed') {
        return res.status(200).send('Event ignored');
    }

    const session = event.data.object;
    const metadata = session.metadata || {};
    const customerDetails = session.customer_details || {};
    const projectKey = metadata.project?.toUpperCase();
    const issueType = metadata.issue || 'Task';
    const summary = metadata.summary || 'New Task';
    const durationDays = parseInt(metadata.duration || '5', 10);
    const amountPaid = (session.amount_total || 0) / 100;
    const currency = session.currency?.toUpperCase() || 'EUR';

    // --- Critical Error Handling for Missing projectKey ---
    if (!projectKey && issueType.toLowerCase() !== 'support') {
        console.error('Missing project key in Stripe metadata.');
        return res.status(400).send('Missing project key in Stripe metadata.');
    }

    const customerEmail = customerDetails.email;
    const customerName = customerDetails.name || 'N/A';
    const phone = customerDetails.phone || 'N/A';
    const address = customerDetails.address || {};
    const companyAddress = [address.line1, address.city, address.postal_code, address.country]
        .filter(Boolean).join(', ') || 'N/A';

    const now = new Date();
    const startDate = now.toISOString().split('T')[0];
    const endDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000)
        .toISOString().split('T')[0];

    const jiraAuth = Buffer.from(`${process.env.JIRA_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
    const jiraDomain = process.env.JIRA_DOMAIN;
    const jsmProjectKey = process.env.JIRA_JSM_PROJECT_KEY;
    const headers = {
        'Authorization': `Basic ${jiraAuth}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
    };

    try {
        await checkAndInviteCustomer(customerEmail, customerName, jsmProjectKey, headers, jiraDomain);

        // --- Conditional Logic based on Stripe Metadata ---
        if (issueType.toLowerCase() === 'support') {
            // Case 1: Create a single JSM ticket for support
            await axios.post(`${jiraDomain}/rest/api/3/issue`, {
                fields: {
                    project: { key: jsmProjectKey },
                    summary: `Support Request for ${summary}`,
                    issuetype: { name: 'Service Request' },
                    description: {
                        "type": "doc",
                        "version": 1,
                        "content": [
                            {
                                "type": "paragraph",
                                "content": [
                                    { "type": "text", "text": `A new support request has been submitted by the customer.` }
                                ]
                            },
                            {
                                "type": "paragraph",
                                "content": [
                                    { "type": "text", "text": `Customer: ${customerName}` }
                                ]
                            },
                            {
                                "type": "paragraph",
                                "content": [
                                    { "type": "text", "text": `Email: ${customerEmail}` }
                                ]
                            },
                            {
                                "type": "paragraph",
                                "content": [
                                    { "type": "text", "text": `Amount Paid: ${amountPaid.toFixed(2)} ${currency}` }
                                ]
                            }
                        ]
                    },
                    [FIELD_EPIC_LINK]: customerEmail // Raise on behalf of field
                }
            }, { headers });
            res.status(200).send('Jira Service Management ticket created');
        } else {
            // Case 2: Create a Jira Epic/Task and a linked JSM ticket
            const epicResponse = await axios.post(`${jiraDomain}/rest/api/3/issue`, {
                fields: {
                    project: { key: projectKey },
                    summary: 'New Client',
                    issuetype: { name: 'Epic' },
                    [FIELD_EPIC_NAME]: 'New Client'
                }
            }, { headers });

            const epicKey = epicResponse.data.key;

            const taskResponse = await axios.post(`${jiraDomain}/rest/api/3/issue`, {
                fields: {
                    project: { key: projectKey },
                    summary: summary,
                    issuetype: { name: issueType },
                    description: {
                        "type": "doc",
                        "version": 1,
                        "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Customer: ${customerName}` }] },
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Email: ${customerEmail}` }] },
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Phone: ${phone}` }] },
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Company Address: ${companyAddress}` }] },
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Amount Paid: ${amountPaid.toFixed(2)} ${currency}` }] },
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Start Date: ${startDate}` }] },
                            { "type": "paragraph", "content": [{ "type": "text", "text": `End Date: ${endDate}` }] }
                        ]
                    },
                    [FIELD_START_DATE]: startDate,
                    duedate: endDate,
                    [FIELD_EPIC_LINK]: epicKey
                }
            }, { headers });

            const taskKey = taskResponse.data.key;

            // Create a JSM ticket for customer visibility
            await axios.post(`${jiraDomain}/rest/api/3/issue`, {
                fields: {
                    project: { key: jsmProjectKey },
                    summary: `Order received for "${summary}"`,
                    issuetype: { name: 'Service Request' },
                    description: {
                        "type": "doc",
                        "version": 1,
                        "content": [
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Your order has been received. Our team has created an internal task to begin work.` }] },
                            { "type": "paragraph", "content": [{ "type": "text", "text": `Internal Task: ${jiraDomain}/browse/${taskKey}` }] }
                        ]
                    },
                    [FIELD_EPIC_LINK]: customerEmail
                }
            }, { headers });

            res.status(200).send('Jira Epic, Task, and JSM ticket created');
        }
    } catch (err) {
        console.error('Error in Jira workflow:', err.response?.data || err.message);
        res.status(500).send('Failed to execute Jira workflow');
    }
});

exports.stripetojira = app;

