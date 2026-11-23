// The Express app. Used by:
//   - src/server.js            (local: npm start)
//   - api/index.js             (Vercel Function)
//   - netlify/functions/api.js (Netlify Function)
require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const db = require('./db');
const { q, ensureSchema, insertBookingIfSeat, searchBookings, HOLD_MINUTES } = db;
const MEETUPS = require('./meetups');
const cashfree = require('./cashfree');
const auth = require('./auth');
const tickets = require('./tickets');

const PORT = Number(process.env.PORT || 3000);
// Public URL: explicit BASE_URL, else what Netlify/Vercel provide, else localhost.
const BASE_URL = (
  process.env.BASE_URL ||
  process.env.URL || // Netlify production URL
  (process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) ||
  `http://localhost:${PORT}`
).replace(/\/+$/, '');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Netlify passes function requests as /.netlify/functions/api/...; normalise back to /api/...
app.use((req, res, next) => {
  const m = req.url.match(/^\/\.netlify\/functions\/api(\/.*)?$/);
  if (m) req.url = '/api' + (m[1] || '');
  next();
});

// ---------- helpers ----------
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

function cleanPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

const publicSlot = (s) => ({
  id: s.id, label: s.label, start_time: s.start_time, end_time: s.end_time,
  price: s.price, capacity: s.capacity, seats_left: Math.max(0, s.capacity - s.taken),
});

const publicEvent = async (e) => ({
  id: e.id, title: e.title, description: e.description, venue: e.venue, map_url: e.map_url,
  event_date: e.event_date, poster_url: e.poster_url, what_to_bring: e.what_to_bring,
  slots: (await q.slotsForEvent.all(e.id)).map(publicSlot),
});

/**
 * Marks a booking paid (once), issues its ticket code and emails the QR. Safe to call repeatedly.
 * The email is awaited: on serverless hosts work after the response may never run.
 */
async function confirmBooking(orderId, cfPaymentId = null) {
  const { changes } = await q.markPaid.run(tickets.newTicketToken(), cfPaymentId, orderId);
  const booking = await q.bookingByOrder.get(orderId);
  if (changes) {
    console.log(`[booking] ${orderId} confirmed for ${booking.email}`);
    try { await tickets.sendTicketEmail(booking.id, BASE_URL); } catch (e) { console.error(`[mail] ${orderId}: ${e.message}`); }
  }
  return q.bookingByOrder.get(orderId);
}

/** Asks Cashfree for the real order status and updates our booking accordingly. */
async function syncWithCashfree(booking) {
  if (booking.status === 'paid' || !cashfree.configured()) return booking;
  const order = await cashfree.getOrder(booking.order_id);
  if (order.order_status === 'PAID') {
    if (Number(order.order_amount) !== booking.amount) {
      console.error(`[payment] amount mismatch on ${booking.order_id}: ${order.order_amount} vs ${booking.amount}`);
      return booking;
    }
    let paymentId = null;
    try {
      const payments = await cashfree.getPayments(booking.order_id);
      paymentId = payments.find((p) => p.payment_status === 'SUCCESS')?.cf_payment_id?.toString() || null;
    } catch { /* payment id is informational only */ }
    return confirmBooking(booking.order_id, paymentId);
  }
  if (order.order_status === 'EXPIRED' || order.order_status === 'TERMINATED') {
    await q.markFailed.run(booking.order_id);
    return q.bookingByOrder.get(booking.order_id);
  }
  return booking; // ACTIVE — not paid yet
}

// Create tables on first API call (cheap no-op afterwards). Without a database, pages still show the hard-coded meetups.
app.use('/api', wrap(async (req, res, next) => { if (db.configured()) await ensureSchema(); next(); }));

/** Hard-coded meetups (src/meetups.js), used when no database is connected. */
const fallbackEvents = () => MEETUPS
  .filter((e) => e.published && e.event_date >= todayIST())
  .sort((a, b) => a.event_date.localeCompare(b.event_date))
  .map(({ slots, ...e }) => ({ ...e, slots: slots.map((s) => publicSlot({ ...s, taken: 0 })) }));

// ---------- Cashfree webhook (needs the raw body for signature check) ----------
app.post('/api/payments/webhook', express.raw({ type: '*/*', limit: '1mb' }), wrap(async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
  if (!cashfree.verifyWebhook(raw, req.get('x-webhook-timestamp'), req.get('x-webhook-signature'))) {
    console.warn('[webhook] invalid signature');
    return res.status(401).json({ error: 'invalid signature' });
  }
  let payload = {};
  try { payload = JSON.parse(raw); } catch { /* ignore */ }
  const orderId = payload?.data?.order?.order_id;
  const booking = orderId && (await q.bookingByOrder.get(orderId));
  // Never trust the webhook body for the payment result — re-fetch the order from Cashfree.
  if (booking) await syncWithCashfree(booking);
  res.json({ ok: true });
}));

app.use(express.json({ limit: '100kb' }));

// ---------- public API ----------
app.get('/api/config', (req, res) => {
  res.json({ cashfreeMode: cashfree.mode(), instagram: process.env.INSTAGRAM_URL || 'https://www.instagram.com/dots.into_line/' });
});

app.get('/api/events', wrap(async (req, res) => {
  if (!db.configured()) return res.json(fallbackEvents());
  const events = await q.publicEvents.all(todayIST());
  res.json(await Promise.all(events.map(publicEvent)));
}));

app.get('/api/events/:id', wrap(async (req, res) => {
  if (!db.configured()) {
    const e = fallbackEvents().find((x) => String(x.id) === String(req.params.id));
    if (!e) throw new HttpError(404, 'This meetup was not found.');
    return res.json(e);
  }
  const e = await q.event.get(req.params.id);
  if (!e || !e.published) throw new HttpError(404, 'This meetup was not found.');
  if (e.event_date < todayIST()) throw new HttpError(410, 'This meetup has already happened.');
  res.json(await publicEvent(e));
}));

app.post('/api/bookings', wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  const email = str(req.body.email, 120).toLowerCase();
  const phone = cleanPhone(req.body.phone);
  const slotId = Number(req.body.slotId);

  if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!phone) throw new HttpError(400, 'Please enter a valid 10-digit Indian mobile number.');
  if (!Number.isInteger(slotId)) throw new HttpError(400, 'Please choose a time slot.');

  const slot = await q.slot.get(slotId);
  const event = slot && (await q.event.get(slot.event_id));
  if (!slot || !event || !event.published) throw new HttpError(404, 'This slot is no longer available.');
  if (event.event_date < todayIST()) throw new HttpError(400, 'This meetup has already happened.');
  if (await q.paidForEmailSlot.get(slotId, email)) throw new HttpError(409, 'This email already has a confirmed spot in this slot. Check your inbox for the QR ticket.');
  if (slot.price > 0 && !cashfree.configured()) throw new HttpError(503, 'Online payments are not set up yet. Please try again later.');

  const orderId = `DIL_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
  const gotSeat = await insertBookingIfSeat({ order_id: orderId, slot_id: slotId, name, email, phone, amount: slot.price });
  if (!gotSeat) throw new HttpError(409, 'Sorry, this slot just filled up. Please pick another one.');

  if (slot.price === 0) {
    await confirmBooking(orderId);
    return res.json({ orderId, free: true });
  }

  try {
    const order = await cashfree.createOrder({
      orderId,
      amount: slot.price,
      customer: { id: 'c_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 20), name, email, phone },
      returnUrl: `${BASE_URL}/status.html?order_id={order_id}`,
      notifyUrl: BASE_URL.startsWith('https://') ? `${BASE_URL}/api/payments/webhook` : undefined,
      note: `${event.title} ${event.event_date} ${slot.start_time}`.slice(0, 200),
      expiresInMinutes: Math.max(16, HOLD_MINUTES),
    });
    await q.setSession.run(order.payment_session_id, orderId);
    res.json({ orderId, paymentSessionId: order.payment_session_id });
  } catch (err) {
    await q.markFailed.run(orderId);
    console.error('[cashfree] create order failed:', err.message, err.data || '');
    throw new HttpError(502, 'Could not start the payment. Please try again in a moment.');
  }
}));

app.get('/api/bookings/:orderId', wrap(async (req, res) => {
  let b = await q.bookingByOrder.get(req.params.orderId);
  if (!b) throw new HttpError(404, 'Booking not found.');
  if (b.status === 'pending') {
    try { b = await syncWithCashfree(b); } catch (e) { console.error('[cashfree] status check failed:', e.message); }
  }
  const full = await q.fullBooking.get(b.id);
  res.json({
    orderId: b.order_id,
    status: b.status,
    name: b.name,
    email: b.email,
    amount: b.amount,
    event: { title: full.event_title, date: full.event_date, venue: full.venue, map_url: full.map_url, what_to_bring: full.what_to_bring },
    slot: { label: full.slot_label, start_time: full.start_time, end_time: full.end_time },
    emailSent: Boolean(b.email_sent_at),
    ticket: b.status === 'paid' ? { code: tickets.prettyCode(b.ticket_token), qr: await tickets.qrDataUrl(b.ticket_token) } : null,
  });
}));

/** Re-open Cashfree checkout for an order that is still awaiting payment. */
app.post('/api/bookings/:orderId/retry', wrap(async (req, res) => {
  const b = await q.bookingByOrder.get(req.params.orderId);
  if (!b) throw new HttpError(404, 'Booking not found.');
  if (b.status !== 'pending' || !b.payment_session_id) throw new HttpError(400, 'This payment can no longer be retried. Please book again.');
  const order = await cashfree.getOrder(b.order_id);
  if (order.order_status !== 'ACTIVE') throw new HttpError(400, 'This payment session has expired. Please book again.');
  res.json({ paymentSessionId: order.payment_session_id || b.payment_session_id });
}));

app.get('/api/tickets/:token/qr.png', wrap(async (req, res) => {
  const token = tickets.normalizeCode(req.params.token);
  const b = token && (await q.bookingByToken.get(token));
  if (!b || b.status !== 'paid') return res.status(404).end();
  res.type('png').set('Cache-Control', 'private, max-age=86400').send(await tickets.qrPng(token));
}));

// ---------- admin API ----------
app.post('/api/admin/login', (req, res) => {
  if (!auth.loginAllowed(req.ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!auth.checkPassword(req.body.password)) {
    auth.recordFailure(req.ip);
    return res.status(401).json({ error: 'Wrong password.' });
  }
  auth.setSession(req, res);
  res.json({ ok: true });
});
app.post('/api/admin/logout', (req, res) => { auth.clearSession(res); res.json({ ok: true }); });

const admin = express.Router();
admin.use(auth.requireAdmin);

admin.get('/me', (req, res) => res.json({ ok: true, today: todayIST(), cashfree: cashfree.configured(), brevo: Boolean(process.env.BREVO_API_KEY) }));

function eventInput(body) {
  const e = {
    title: str(body.title, 120), description: str(body.description, 3000), venue: str(body.venue, 200),
    map_url: str(body.map_url, 500), event_date: str(body.event_date, 10), poster_url: str(body.poster_url, 500),
    what_to_bring: str(body.what_to_bring, 500), published: body.published ? 1 : 0,
  };
  if (!e.title) throw new HttpError(400, 'Title is required.');
  if (!isDate(e.event_date)) throw new HttpError(400, 'Date is required.');
  for (const k of ['map_url', 'poster_url']) if (e[k] && !/^https?:\/\//i.test(e[k]) && !e[k].startsWith('/')) throw new HttpError(400, `${k} must be a link.`);
  return e;
}

function slotInput(body) {
  const s = {
    label: str(body.label, 60), start_time: str(body.start_time, 5), end_time: str(body.end_time, 5),
    capacity: Number(body.capacity), price: Number(body.price || 0),
  };
  if (!isTime(s.start_time) || !isTime(s.end_time)) throw new HttpError(400, 'Start and end time are required.');
  if (!Number.isInteger(s.capacity) || s.capacity < 1 || s.capacity > 10000) throw new HttpError(400, 'Capacity must be a whole number ≥ 1.');
  if (!Number.isInteger(s.price) || s.price < 0 || s.price > 100000) throw new HttpError(400, 'Price must be whole rupees (0 for free).');
  return s;
}

admin.get('/events', wrap(async (req, res) => {
  const events = await q.allEvents.all();
  res.json(await Promise.all(events.map(async (e) => ({ ...e, slots: await q.slotsForEvent.all(e.id) }))));
}));
admin.post('/events', wrap(async (req, res) => {
  const { lastInsertRowid } = await q.insertEvent.run(eventInput(req.body));
  res.json({ id: Number(lastInsertRowid) });
}));
admin.put('/events/:id', wrap(async (req, res) => {
  if (!(await q.event.get(req.params.id))) throw new HttpError(404, 'Event not found.');
  await q.updateEvent.run({ ...eventInput(req.body), id: Number(req.params.id) });
  res.json({ ok: true });
}));
admin.delete('/events/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if ((await q.paidCountForEvent.get(id)).n > 0) throw new HttpError(409, 'This event has paid bookings. Unpublish it instead of deleting.');
  await q.deleteUnpaidForEvent.run(id);
  await q.deleteEvent.run(id);
  res.json({ ok: true });
}));
admin.post('/events/:id/slots', wrap(async (req, res) => {
  if (!(await q.event.get(req.params.id))) throw new HttpError(404, 'Event not found.');
  const { lastInsertRowid } = await q.insertSlot.run({ ...slotInput(req.body), event_id: Number(req.params.id) });
  res.json({ id: Number(lastInsertRowid) });
}));
admin.put('/slots/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await q.slot.get(id);
  if (!existing) throw new HttpError(404, 'Slot not found.');
  const s = slotInput(req.body);
  const paid = (await q.paidCountForSlot.get(id)).n;
  if (s.capacity < paid) throw new HttpError(400, `Capacity can't be below the ${paid} confirmed bookings.`);
  if (paid > 0 && s.price !== existing.price) throw new HttpError(400, 'Price can’t change once people have paid. Add a new slot instead.');
  await q.updateSlot.run({ ...s, id });
  res.json({ ok: true });
}));
admin.delete('/slots/:id', wrap(async (req, res) => {
  const id = Number(req.params.id);
  if ((await q.paidCountForSlot.get(id)).n > 0) throw new HttpError(409, 'This slot has paid bookings and can’t be deleted.');
  await q.deleteUnpaidForSlot.run(id);
  await q.deleteSlot.run(id);
  res.json({ ok: true });
}));

function adminBookingView(b) {
  return {
    id: b.id, order_id: b.order_id, name: b.name, email: b.email, phone: b.phone, amount: b.amount, status: b.status,
    code: tickets.prettyCode(b.ticket_token), checked_in_at: b.checked_in_at, paid_at: b.paid_at, created_at: b.created_at,
    email_sent_at: b.email_sent_at, email_error: b.email_error,
    event_id: b.event_id, event_title: b.event_title, event_date: b.event_date, venue: b.venue,
    slot_label: b.slot_label, start_time: b.start_time, end_time: b.end_time,
  };
}

admin.get('/bookings', wrap(async (req, res) => {
  const rows = await searchBookings({ eventId: req.query.event_id, status: req.query.status, search: str(req.query.q, 100) });
  res.json(rows.map(adminBookingView));
}));

admin.get('/bookings.csv', wrap(async (req, res) => {
  const rows = await searchBookings({ eventId: req.query.event_id, status: req.query.status || 'paid', search: str(req.query.q, 100) });
  const cols = ['order_id', 'code', 'name', 'email', 'phone', 'event_title', 'event_date', 'start_time', 'end_time', 'amount', 'status', 'paid_at', 'checked_in_at'];
  const cell = (v) => {
    let s = v instanceof Date ? v.toISOString() : String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(','), ...rows.map(adminBookingView).map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
  res.type('text/csv').attachment(`dots-into-line-bookings-${todayIST()}.csv`).send('﻿' + csv);
}));

/** Look up a scanned QR / typed code. Does NOT check the person in. */
admin.post('/verify', wrap(async (req, res) => {
  const token = tickets.normalizeCode(req.body.code);
  const raw = token && (await q.bookingByToken.get(token));
  if (!raw) return res.json({ result: 'invalid', message: 'Not a valid Dots into Line ticket.' });
  const b = adminBookingView(await q.fullBooking.get(raw.id));
  if (raw.status !== 'paid') return res.json({ result: 'unpaid', message: 'Payment not completed for this booking.', booking: b });
  const today = todayIST();
  const dateNote = b.event_date === today ? null : b.event_date > today ? 'This ticket is for a future date.' : 'This ticket is for a past meetup.';
  if (raw.checked_in_at) return res.json({ result: 'used', message: 'Already checked in.', booking: b, dateNote });
  res.json({ result: 'valid', message: 'Valid ticket.', booking: b, dateNote });
}));

admin.post('/bookings/:id/checkin', wrap(async (req, res) => {
  const id = Number(req.params.id);
  const b = await q.bookingById.get(id);
  if (!b || b.status !== 'paid') throw new HttpError(400, 'Only paid bookings can be checked in.');
  const { changes } = await q.checkIn.run(id);
  res.json({ ok: true, alreadyCheckedIn: !changes, booking: adminBookingView(await q.fullBooking.get(id)) });
}));
admin.post('/bookings/:id/undo-checkin', wrap(async (req, res) => {
  await q.undoCheckIn.run(req.params.id);
  res.json({ ok: true });
}));
admin.post('/bookings/:id/resend', wrap(async (req, res) => {
  const b = await q.bookingById.get(req.params.id);
  if (!b || b.status !== 'paid') throw new HttpError(400, 'Only paid bookings have a ticket to send.');
  await tickets.sendTicketEmail(b.id, BASE_URL);
  res.json({ ok: true });
}));
admin.post('/bookings/:id/sync', wrap(async (req, res) => {
  const b = await q.bookingById.get(req.params.id);
  if (!b) throw new HttpError(404, 'Booking not found.');
  const updated = await syncWithCashfree(b);
  res.json({ ok: true, status: updated.status });
}));

app.use('/api/admin', admin);

// ---------- static site (local only; Netlify/Vercel serve public/ from their CDN) ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('/admin', (req, res) => res.redirect('/admin/'));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  const expose = err instanceof HttpError || err.expose;
  if (status >= 500 && !expose) console.error(err);
  res.status(status).json({ error: status >= 500 && !expose ? 'Something went wrong.' : err.message });
});

module.exports = app;
module.exports.BASE_URL = BASE_URL;
