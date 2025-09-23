const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const express = require('express');
const app = express();

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post('/stripeToJira', express.raw({ type: 'application/json' }), async (req, res) => {
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
  const headers = {
    'Authorization': `Basic ${jiraAuth}`,
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Create TheEpic
    const epicResponse = await axios.post(`${jiraDomain}/rest/api/3/issue`, {
      fields: {
        project: { key: projectKey },
        summary: 'New Client',
        issuetype: { name: 'Epic' },
        customfield_10011: 'New Client' // Epic Name
      }
    }, { headers });

    const epicKey = epicResponse.data.key;

    // 2. Create Task in Epic
    await axios.post(`${jiraDomain}/rest/api/3/issue`, {
      fields: {
        project: { key: projectKey },
        summary: summary,
        issuetype: { name: issueType },
        description: `
Customer: ${customerName}
Email: ${customerEmail}
Phone: ${phone}
Company Address: ${companyAddress}
Amount Paid: ${amountPaid.toFixed(2)} ${currency}
Start Date: ${startDate}
End Date: ${endDate}
        `,
        customfield_10015: startDate, // Start Date
        duedate: endDate,              // Due Date
        customfield_10014: epicKey    // Epic Link
      }
    }, {
      headers,
      params: { raiseOnBehalfOf: customerEmail }
    });

    res.status(200).send('Jira Epic and Task created');
  } catch (err) {
    console.error('Error creating Jira issue:', err.response?.data || err.message);
    res.status(500).send('Failed to create Jira issue');
  }
});

exports.stripeToJira = app;
