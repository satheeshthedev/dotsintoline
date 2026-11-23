require('dotenv').config({ quiet: true });
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const { q } = require('./db');
const tickets = require('./tickets');

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

// ---------- helpers ----------
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const str = (v, max = 500) => String(v ?? '').trim().slice(0, max);

function cleanPhone(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : null;
}

const publicSlot = (s) => ({
  id: s.id, label: s.label, start_time: s.start_time, end_time: s.end_time,
  capacity: s.capacity, seats_left: Math.max(0, s.capacity - s.taken),
});

const publicEvent = (e) => ({
  id: e.id, title: e.title, description: e.description, venue: e.venue, map_url: e.map_url,
  event_date: e.event_date, poster_url: e.poster_url, what_to_bring: e.what_to_bring,
  slots: q.slotsForEvent.all(e.id).map(publicSlot),
});

// ---------- API ----------
app.get('/api/config', (req, res) => {
  res.json({ instagram: process.env.INSTAGRAM_URL || 'https://www.instagram.com/dots.into_line/' });
});

app.get('/api/events', (req, res) => {
  res.json(q.publicEvents.all(todayIST()).map(publicEvent));
});

/** Phase 1: registration is free — confirm immediately and email the QR ticket. */
app.post('/api/bookings', wrap(async (req, res) => {
  const name = str(req.body.name, 80);
  const email = str(req.body.email, 120).toLowerCase();
  const phone = cleanPhone(req.body.phone);
  const slotId = Number(req.body.slotId);

  if (name.length < 2) throw new HttpError(400, 'Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!phone) throw new HttpError(400, 'Please enter a valid 10-digit Indian mobile number.');

  const slot = q.slot.get(slotId);
  const event = slot && q.event.get(slot.event_id);
  if (!slot || !event || !event.published) throw new HttpError(404, 'This slot is no longer available.');
  if (event.event_date < todayIST()) throw new HttpError(400, 'This meetup has already happened.');
  if (q.paidForEmailSlot.get(slotId, email)) throw new HttpError(409, 'This email is already registered for this slot. Check your inbox for the QR ticket.');
  if (slot.taken >= slot.capacity) throw new HttpError(409, 'Sorry, this slot just filled up. Please pick another one.');

  const orderId = `DIL_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`.toUpperCase();
  q.insertBooking.run({ order_id: orderId, slot_id: slotId, name, email, phone, amount: 0 });
  q.markPaid.run(tickets.newTicketToken(), null, orderId);
  const booking = q.bookingByOrder.get(orderId);
  console.log(`[booking] ${orderId} registered for ${email}`);
  tickets.sendTicketEmail(booking.id, BASE_URL).catch((e) => console.error(`[mail] ${orderId}: ${e.message}`));
  res.json({ orderId });
}));

app.get('/api/bookings/:orderId', wrap(async (req, res) => {
  const b = q.bookingByOrder.get(req.params.orderId);
  if (!b) throw new HttpError(404, 'Registration not found.');
  const full = q.fullBooking.get(b.id);
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

app.get('/api/tickets/:token/qr.png', wrap(async (req, res) => {
  const token = tickets.normalizeCode(req.params.token);
  const b = token && q.bookingByToken.get(token);
  if (!b || b.status !== 'paid') return res.status(404).end();
  res.type('png').set('Cache-Control', 'private, max-age=86400').send(await tickets.qrPng(token));
}));

// ---------- static site ----------
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Something went wrong.' : err.message });
});

app.listen(PORT, () => {
  console.log(`Dots into Line running at ${BASE_URL}`);
  if (!process.env.BREVO_API_KEY) console.warn('[mail] BREVO_API_KEY not set — ticket emails are saved to data/outbox instead.');
});
