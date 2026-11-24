// Bookings store. MongoDB Atlas when MONGODB_URI is set; otherwise a local file
// (data/store.json) so registration works on this computer. Serverless hosts have
// no disk, so they keep the "opening soon" response until Atlas is connected.
const fs = require('fs');
const path = require('path');

const HOLD_MINUTES = Math.max(1, Math.floor(Number(process.env.HOLD_MINUTES || 20)));
const MONGODB_URI = process.env.MONGODB_URI || process.env.MONGO_URL || '';
const serverless = Boolean(process.env.VERCEL || process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
const FILE = path.join(__dirname, '..', 'data', 'store.json');

const EVENT_COLS = ['title', 'description', 'venue', 'map_url', 'event_date', 'poster_url', 'what_to_bring', 'published'];
const SLOT_COLS = ['label', 'start_time', 'end_time', 'capacity', 'price'];

const configured = () => Boolean(MONGODB_URI) || !serverless;

function unavailable() {
  console.error('[db] MONGODB_URI is not set — connect MongoDB Atlas.');
  throw Object.assign(new Error('Registrations are opening soon. Please try again in a little while.'), { status: 503, expose: true });
}

const nowIso = () => new Date().toISOString();
const holding = (b, now = Date.now()) =>
  b.status === 'paid' || (b.status === 'pending' && Date.parse(b.created_at) > now - HOLD_MINUTES * 60 * 1000);

function pick(src, cols) {
  const out = {};
  for (const k of cols) out[k] = src[k];
  return out;
}

function clean(doc) {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return rest;
}

function slotStats(slot, bookings) {
  const rows = bookings.filter((b) => b.slot_id === slot.id);
  return {
    ...clean(slot),
    taken: rows.filter((b) => holding(b)).length,
    paid: rows.filter((b) => b.status === 'paid').length,
    checked_in: rows.filter((b) => b.status === 'paid' && b.checked_in_at).length,
  };
}

function joinBooking(b, slots, events) {
  const s = slots.find((x) => x.id === b.slot_id);
  const e = s && events.find((x) => x.id === s.event_id);
  return {
    ...clean(b),
    slot_label: s ? s.label : '',
    start_time: s && s.start_time,
    end_time: s && s.end_time,
    price: s && s.price,
    event_id: e && e.id,
    event_title: e && e.title,
    event_date: e && e.event_date,
    venue: e && e.venue,
    map_url: e && e.map_url,
    what_to_bring: e && e.what_to_bring,
  };
}

// ---------- local file ----------
function emptyStore() {
  return { events: [], slots: [], bookings: [], seq: { events: 0, slots: 0, bookings: 0 } };
}

let fileQueue = Promise.resolve();
function withFile(fn) {
  const run = fileQueue.then(async () => {
    let store = emptyStore();
    try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* first run */ }
    const result = await fn(store);
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, FILE);
    return result;
  });
  fileQueue = run.then(() => {}, () => {});
  return run;
}

function nextId(store, key) {
  store.seq[key] = (store.seq[key] || 0) + 1;
  return store.seq[key];
}
function noteId(store, key, id) {
  store.seq[key] = Math.max(store.seq[key] || 0, id);
}

const fileBackend = {
  async snapshot() {
    return withFile(async (store) => ({
      events: store.events.map(clean),
      slots: store.slots.map(clean),
      bookings: store.bookings.map(clean),
    }));
  },
  async seed(meetups) {
    return withFile(async (store) => {
      if (store.events.length) return false;
      for (const e of meetups) {
        store.events.push({ id: e.id, ...pick(e, EVENT_COLS), created_at: nowIso() });
        noteId(store, 'events', e.id);
        for (const s of e.slots) {
          store.slots.push({ id: s.id, event_id: e.id, ...pick(s, SLOT_COLS) });
          noteId(store, 'slots', s.id);
        }
      }
      return true;
    });
  },
  async insertEvent(fields) {
    return withFile(async (store) => {
      const id = nextId(store, 'events');
      store.events.push({ id, ...fields, created_at: nowIso() });
      return id;
    });
  },
  async updateEvent(id, fields) {
    return withFile(async (store) => {
      const e = store.events.find((x) => x.id === id);
      if (e) Object.assign(e, fields);
    });
  },
  async deleteEvent(id) {
    return withFile(async (store) => {
      store.events = store.events.filter((e) => e.id !== id);
      store.slots = store.slots.filter((s) => s.event_id !== id);
    });
  },
  async insertSlot(fields) {
    return withFile(async (store) => {
      const id = nextId(store, 'slots');
      store.slots.push({ id, ...fields });
      return id;
    });
  },
  async updateSlot(id, fields) {
    return withFile(async (store) => {
      const s = store.slots.find((x) => x.id === id);
      if (s) Object.assign(s, fields);
    });
  },
  async deleteSlot(id) {
    return withFile(async (store) => { store.slots = store.slots.filter((s) => s.id !== id); });
  },
  async insertIfSeat(b) {
    return withFile(async (store) => {
      const slot = store.slots.find((s) => s.id === b.slot_id);
      if (!slot) return false;
      const taken = store.bookings.filter((x) => x.slot_id === b.slot_id && holding(x)).length;
      if (taken >= slot.capacity) return false;
      store.bookings.push({
        id: nextId(store, 'bookings'),
        order_id: b.order_id, slot_id: b.slot_id, name: b.name, email: b.email, phone: b.phone,
        amount: b.amount, status: 'pending', created_at: nowIso(),
      });
      return true;
    });
  },
  async updateBooking(match, fields) {
    return withFile(async (store) => {
      const rows = store.bookings.filter(match);
      for (const row of rows) Object.assign(row, fields);
      return rows.length;
    });
  },
  async deleteBookings(match) {
    return withFile(async (store) => { store.bookings = store.bookings.filter((b) => !match(b)); });
  },
};

// ---------- MongoDB Atlas ----------
let mongoClient = null;
async function mongoDb() {
  if (!MONGODB_URI) unavailable();
  if (!mongoClient) {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(MONGODB_URI);
    await mongoClient.connect();
  }
  let name = 'dotsintoline';
  try {
    const parsed = new URL(MONGODB_URI.replace(/^mongodb(\+srv)?:/, 'http:'));
    const fromPath = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] || '');
    if (fromPath) name = fromPath;
  } catch { /* default name */ }
  return mongoClient.db(name);
}

async function nextMongoId(db, key, session) {
  const result = await db.collection('counters').findOneAndUpdate(
    { _id: key },
    { $inc: { n: 1 } },
    { upsert: true, returnDocument: 'after', session },
  );
  const doc = result && Object.prototype.hasOwnProperty.call(result, 'value') ? result.value : result;
  return doc.n;
}

const mongoBackend = {
  async snapshot() {
    const db = await mongoDb();
    const [events, slots, bookings] = await Promise.all([
      db.collection('events').find({}).toArray(),
      db.collection('slots').find({}).toArray(),
      db.collection('bookings').find({}).toArray(),
    ]);
    return { events: events.map(clean), slots: slots.map(clean), bookings: bookings.map(clean) };
  },
  async seed(meetups) {
    const db = await mongoDb();
    const events = db.collection('events');
    if (await events.countDocuments()) return false;
    const slots = db.collection('slots');
    if (meetups.length) {
      await events.insertMany(meetups.map((e) => ({ _id: e.id, id: e.id, ...pick(e, EVENT_COLS), created_at: nowIso() })));
      const slotDocs = meetups.flatMap((e) => e.slots.map((s) => ({ _id: s.id, id: s.id, event_id: e.id, ...pick(s, SLOT_COLS) })));
      if (slotDocs.length) await slots.insertMany(slotDocs);
    }
    const max = (rows) => rows.reduce((n, row) => Math.max(n, row.id), 0);
    await db.collection('counters').bulkWrite([
      { updateOne: { filter: { _id: 'events' }, update: { $max: { n: max(meetups) } }, upsert: true } },
      { updateOne: { filter: { _id: 'slots' }, update: { $max: { n: max(meetups.flatMap((e) => e.slots)) } }, upsert: true } },
      { updateOne: { filter: { _id: 'bookings' }, update: { $max: { n: 0 } }, upsert: true } },
    ]);
    await db.collection('bookings').createIndex({ order_id: 1 }, { unique: true });
    await db.collection('bookings').createIndex({ ticket_token: 1 }, { unique: true, sparse: true });
    await db.collection('bookings').createIndex({ slot_id: 1, status: 1 });
    return true;
  },
  async insertEvent(fields) {
    const db = await mongoDb();
    const id = await nextMongoId(db, 'events');
    await db.collection('events').insertOne({ _id: id, id, ...fields, created_at: nowIso() });
    return id;
  },
  async updateEvent(id, fields) {
    const db = await mongoDb();
    await db.collection('events').updateOne({ id }, { $set: fields });
  },
  async deleteEvent(id) {
    const db = await mongoDb();
    await db.collection('events').deleteOne({ id });
    await db.collection('slots').deleteMany({ event_id: id });
  },
  async insertSlot(fields) {
    const db = await mongoDb();
    const id = await nextMongoId(db, 'slots');
    await db.collection('slots').insertOne({ _id: id, id, ...fields });
    return id;
  },
  async updateSlot(id, fields) {
    const db = await mongoDb();
    await db.collection('slots').updateOne({ id }, { $set: fields });
  },
  async deleteSlot(id) {
    const db = await mongoDb();
    await db.collection('slots').deleteOne({ id });
  },
  async insertIfSeat(b) {
    const db = await mongoDb();
    const session = mongoClient.startSession();
    const flag = { ok: false };
    try {
      await session.withTransaction(async () => {
        flag.ok = false;
        const slot = await db.collection('slots').findOne({ id: b.slot_id }, { session });
        if (!slot) return;
        const rows = await db.collection('bookings').find({ slot_id: b.slot_id }, { session }).toArray();
        if (rows.filter((row) => holding(row)).length >= slot.capacity) return;
        const id = await nextMongoId(db, 'bookings', session);
        await db.collection('bookings').insertOne({
          _id: id, id,
          order_id: b.order_id, slot_id: b.slot_id, name: b.name, email: b.email, phone: b.phone,
          amount: b.amount, status: 'pending', created_at: nowIso(),
        }, { session });
        flag.ok = true;
      });
    } finally {
      await session.endSession();
    }
    return flag.ok;
  },
  async updateBooking(match, fields) {
    const db = await mongoDb();
    const rows = (await db.collection('bookings').find({}).toArray()).filter(match);
    if (!rows.length) return 0;
    const result = await db.collection('bookings').updateMany({ id: { $in: rows.map((r) => r.id) } }, { $set: fields });
    return result.modifiedCount;
  },
  async deleteBookings(match) {
    const db = await mongoDb();
    const rows = (await db.collection('bookings').find({}).toArray()).filter(match);
    if (!rows.length) return;
    await db.collection('bookings').deleteMany({ id: { $in: rows.map((r) => r.id) } });
  },
};

const backend = () => (MONGODB_URI ? mongoBackend : fileBackend);

let schemaReady = null;
function ensureSchema() {
  if (!configured()) return Promise.reject(unavailable());
  return (schemaReady ||= (async () => {
    const added = await backend().seed(require('./meetups'));
    if (added) console.log('[db] added hard-coded meetup(s) to the empty database');
  })().catch((e) => { schemaReady = null; throw e; }));
}

async function snap() {
  if (!configured()) unavailable();
  await ensureSchema();
  return backend().snapshot();
}

const q = {
  publicEvents: { all: async (today) => (await snap()).events.filter((e) => e.published === 1 && e.event_date >= today).sort((a, b) => a.event_date.localeCompare(b.event_date)) },
  allEvents: { all: async () => (await snap()).events.slice().sort((a, b) => b.event_date.localeCompare(a.event_date)) },
  event: { get: async (id) => (await snap()).events.find((e) => e.id === Number(id)) || null },
  insertEvent: { run: async (e) => ({ lastInsertRowid: await backend().insertEvent(pick(e, EVENT_COLS)) }) },
  updateEvent: { run: (e) => backend().updateEvent(Number(e.id), pick(e, EVENT_COLS)) },
  deleteEvent: { run: (id) => backend().deleteEvent(Number(id)) },

  slotsForEvent: {
    all: async (eventId) => {
      const { slots, bookings } = await snap();
      return slots.filter((s) => s.event_id === Number(eventId)).sort((a, b) => a.start_time.localeCompare(b.start_time)).map((s) => slotStats(s, bookings));
    },
  },
  slot: {
    get: async (id) => {
      const { slots, bookings } = await snap();
      const s = slots.find((x) => x.id === Number(id));
      return s ? slotStats(s, bookings) : null;
    },
  },
  insertSlot: { run: async (s) => ({ lastInsertRowid: await backend().insertSlot({ event_id: Number(s.event_id), ...pick(s, SLOT_COLS) }) }) },
  updateSlot: { run: (s) => backend().updateSlot(Number(s.id), pick(s, SLOT_COLS)) },
  deleteSlot: { run: (id) => backend().deleteSlot(Number(id)) },
  paidCountForSlot: { get: async (id) => ({ n: (await snap()).bookings.filter((b) => b.slot_id === Number(id) && b.status === 'paid').length }) },
  paidCountForEvent: {
    get: async (id) => {
      const { slots, bookings } = await snap();
      const ids = new Set(slots.filter((s) => s.event_id === Number(id)).map((s) => s.id));
      return { n: bookings.filter((b) => ids.has(b.slot_id) && b.status === 'paid').length };
    },
  },
  deleteUnpaidForSlot: { run: (id) => backend().deleteBookings((b) => b.slot_id === Number(id) && b.status !== 'paid') },
  deleteUnpaidForEvent: {
    run: async (id) => {
      const { slots } = await snap();
      const ids = new Set(slots.filter((s) => s.event_id === Number(id)).map((s) => s.id));
      return backend().deleteBookings((b) => ids.has(b.slot_id) && b.status !== 'paid');
    },
  },

  setSession: { run: (sessionId, orderId) => backend().updateBooking((b) => b.order_id === orderId, { payment_session_id: sessionId }) },
  bookingByOrder: { get: async (orderId) => (await snap()).bookings.find((b) => b.order_id === orderId) || null },
  bookingById: { get: async (id) => (await snap()).bookings.find((b) => b.id === Number(id)) || null },
  bookingByToken: { get: async (token) => (await snap()).bookings.find((b) => b.ticket_token === token) || null },
  paidForEmailSlot: {
    get: async (slotId, email) => (await snap()).bookings.find((b) => b.slot_id === Number(slotId) && b.email.toLowerCase() === String(email).toLowerCase() && b.status === 'paid') || null,
  },
  markPaid: {
    run: (token, cfPaymentId, orderId) => backend().updateBooking(
      (b) => b.order_id === orderId && b.status !== 'paid',
      { status: 'paid', paid_at: nowIso(), ticket_token: token, cf_payment_id: cfPaymentId },
    ).then((changes) => ({ changes })),
  },
  markFailed: { run: (orderId) => backend().updateBooking((b) => b.order_id === orderId && b.status === 'pending', { status: 'failed' }) },
  emailOk: { run: (id) => backend().updateBooking((b) => b.id === Number(id), { email_sent_at: nowIso(), email_error: null }) },
  emailErr: { run: (msg, id) => backend().updateBooking((b) => b.id === Number(id), { email_error: msg }) },
  checkIn: {
    run: (id) => backend().updateBooking(
      (b) => b.id === Number(id) && b.status === 'paid' && !b.checked_in_at,
      { checked_in_at: nowIso() },
    ).then((changes) => ({ changes })),
  },
  undoCheckIn: { run: (id) => backend().updateBooking((b) => b.id === Number(id), { checked_in_at: null }) },
  fullBooking: {
    get: async (id) => {
      const { events, slots, bookings } = await snap();
      const b = bookings.find((x) => x.id === Number(id));
      return b ? joinBooking(b, slots, events) : null;
    },
  },
};

async function insertBookingIfSeat(b) {
  if (!configured()) unavailable();
  await ensureSchema();
  return backend().insertIfSeat(b);
}

async function searchBookings({ eventId, status, search }) {
  const { events, slots, bookings } = await snap();
  let rows = bookings.map((b) => joinBooking(b, slots, events));
  if (eventId) rows = rows.filter((r) => r.event_id === Number(eventId));
  if (status === 'checked_in') rows = rows.filter((r) => r.status === 'paid' && r.checked_in_at);
  else if (status === 'not_checked_in') rows = rows.filter((r) => r.status === 'paid' && !r.checked_in_at);
  else if (status) rows = rows.filter((r) => r.status === status);
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((r) => [r.name, r.email, r.phone, r.order_id, r.ticket_token].some((v) => String(v || '').toLowerCase().includes(s)));
  }
  rows.sort((a, b) => b.event_date.localeCompare(a.event_date) || a.start_time.localeCompare(b.start_time) || String(b.created_at).localeCompare(String(a.created_at)));
  return rows.slice(0, 2000);
}

module.exports = { q, configured, ensureSchema, insertBookingIfSeat, searchBookings, HOLD_MINUTES };
