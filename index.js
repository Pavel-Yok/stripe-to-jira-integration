const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const express = require('express');
const app = express();

const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

app.post('*', express.raw({ type: 'application/json' }), async (req, res) => {
    // Your existing code from here
    const sig = req.headers['stripe-signature'];
    let event;
    // ... rest of your code
});

exports.stripetojira = app;
