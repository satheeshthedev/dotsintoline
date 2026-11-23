// Cashfree Payment Gateway (PG) REST API — https://docs.cashfree.com/reference/pg-new-apis-endpoint
const crypto = require('crypto');

const API_VERSION = '2023-08-01';
const isProd = () => process.env.CASHFREE_ENV === 'production';
const baseUrl = () => (isProd() ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg');

function configured() {
  return Boolean(process.env.CASHFREE_APP_ID && process.env.CASHFREE_SECRET_KEY);
}

async function request(method, path, body) {
  const res = await fetch(baseUrl() + path, {
    method,
    headers: {
      'x-client-id': process.env.CASHFREE_APP_ID,
      'x-client-secret': process.env.CASHFREE_SECRET_KEY,
      'x-api-version': API_VERSION,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || `Cashfree request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** IST timestamp in the ISO-8601 form Cashfree expects, e.g. 2026-11-23T10:20:12+05:30 */
function istIso(date) {
  const ist = new Date(date.getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 19) + '+05:30';
}

function createOrder({ orderId, amount, customer, returnUrl, notifyUrl, note, expiresInMinutes }) {
  const body = {
    order_id: orderId,
    order_amount: amount,
    order_currency: 'INR',
    customer_details: {
      customer_id: customer.id,
      customer_name: customer.name,
      customer_email: customer.email,
      customer_phone: customer.phone,
    },
    order_meta: { return_url: returnUrl },
    order_note: note,
  };
  if (notifyUrl) body.order_meta.notify_url = notifyUrl;
  if (expiresInMinutes) body.order_expiry_time = istIso(new Date(Date.now() + expiresInMinutes * 60 * 1000));
  return request('POST', '/orders', body);
}

function getOrder(orderId) {
  return request('GET', `/orders/${encodeURIComponent(orderId)}`);
}

function getPayments(orderId) {
  return request('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
}

/** Webhook signature = base64(HMAC_SHA256(timestamp + rawBody, secretKey)) */
function verifyWebhook(rawBody, timestamp, signature) {
  if (!timestamp || !signature) return false;
  const expected = crypto
    .createHmac('sha256', process.env.CASHFREE_SECRET_KEY || '')
    .update(timestamp + rawBody)
    .digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { configured, createOrder, getOrder, getPayments, verifyWebhook, mode: () => (isProd() ? 'production' : 'sandbox') };
