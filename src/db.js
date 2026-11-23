// Postgres (Neon) data layer — works on Netlify Functions, Vercel Functions and locally.
const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL || process.env.POSTGRES_URL;
const HOLD_MINUTES = Math.max(1, Math.floor(Number(process.env.HOLD_MINUTES || 20)));

const configured = () => Boolean(DATABASE_URL);

let sql = null;
function client() {
  if (!DATABASE_URL) {
    console.error('[db] DATABASE_URL is not set — connect a Neon Postgres database.');
    throw Object.assign(new Error('Registrations are opening soon. Please try again in a little while.'), { status: 503, expose: true });
  }
  return (sql ||= neon(DATABASE_URL));
}
const query = (text, params = []) => client().query(text, params);
const one = async (text, params) => (await query(text, params))[0] || null;

// ---------- schema (created automatically on first use) ----------
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS events (
    id            SERIAL PRIMARY KEY,
    title         TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    venue         TEXT NOT NULL DEFAULT '',
    map_url       TEXT NOT NULL DEFAULT '',
    event_date    TEXT NOT NULL,
    poster_url    TEXT NOT NULL DEFAULT '',
    what_to_bring TEXT NOT NULL DEFAULT '',
    published     INTEGER NOT NULL DEFAULT 1,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now())`,
  `CREATE TABLE IF NOT EXISTS slots (
    id          SERIAL PRIMARY KEY,
    event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    label       TEXT NOT NULL DEFAULT '',
    start_time  TEXT NOT NULL,
    end_time    TEXT NOT NULL,
    capacity    INTEGER NOT NULL,
    price       INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS bookings (
    id                 SERIAL PRIMARY KEY,
    order_id           TEXT NOT NULL UNIQUE,
    slot_id            INTEGER NOT NULL REFERENCES slots(id),
    name               TEXT NOT NULL,
    email              TEXT NOT NULL,
    phone              TEXT NOT NULL,
    amount             INTEGER NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending',
    payment_session_id TEXT,
    cf_payment_id      TEXT,
    ticket_token       TEXT UNIQUE,
    email_sent_at      TIMESTAMPTZ,
    email_error        TEXT,
    checked_in_at      TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at            TIMESTAMPTZ)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(lower(email))`,
];
let schemaReady = null;
function ensureSchema() {
  return (schemaReady ||= (async () => {
    for (const s of SCHEMA) await query(s);
    await seedHardcodedMeetups();
  })().catch((e) => { schemaReady = null; throw e; }));
}

/** First run on an empty database: copy the hard-coded meetups in, keeping their ids so links stay the same. */
async function seedHardcodedMeetups() {
  const { n } = await one(`SELECT COUNT(*)::int AS n FROM events`);
  if (n > 0) return;
  const meetups = require('./meetups');
  for (const e of meetups) {
    await query(`INSERT INTO events (id, ${EVENT_COLS.join(', ')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO NOTHING`,
      [e.id, ...EVENT_COLS.map((k) => e[k])]);
    for (const s of e.slots) {
      await query(`INSERT INTO slots (id, event_id, ${SLOT_COLS.join(', ')}) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
        [s.id, e.id, ...SLOT_COLS.map((k) => s[k])]);
    }
  }
  // keep the id counters ahead of the ids we inserted by hand
  await query(`SELECT setval(pg_get_serial_sequence('events', 'id'), GREATEST((SELECT MAX(id) FROM events), 1))`);
  await query(`SELECT setval(pg_get_serial_sequence('slots', 'id'), GREATEST((SELECT MAX(id) FROM slots), 1))`);
  console.log(`[db] added ${meetups.length} hard-coded meetup(s) to the empty database`);
}

// seats held = paid + recent unpaid (someone is on the payment page)
const takenSql = `(SELECT COUNT(*)::int FROM bookings b WHERE b.slot_id = s.id AND
   (b.status = 'paid' OR (b.status = 'pending' AND b.created_at > now() - interval '${HOLD_MINUTES} minutes')))`;

const fullBookingSql = `SELECT b.*, s.label AS slot_label, s.start_time, s.end_time, s.price,
    e.id AS event_id, e.title AS event_title, e.event_date, e.venue, e.map_url, e.what_to_bring
  FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN events e ON e.id = s.event_id`;

const EVENT_COLS = ['title', 'description', 'venue', 'map_url', 'event_date', 'poster_url', 'what_to_bring', 'published'];
const SLOT_COLS = ['label', 'start_time', 'end_time', 'capacity', 'price'];

const q = {
  // events
  publicEvents: { all: (today) => query(`SELECT * FROM events WHERE published = 1 AND event_date >= $1 ORDER BY event_date`, [today]) },
  allEvents: { all: () => query(`SELECT * FROM events ORDER BY event_date DESC`) },
  event: { get: (id) => one(`SELECT * FROM events WHERE id = $1`, [Number(id)]) },
  insertEvent: {
    run: async (e) => ({ lastInsertRowid: (await one(
      `INSERT INTO events (${EVENT_COLS.join(', ')}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, EVENT_COLS.map((k) => e[k]))).id }),
  },
  updateEvent: {
    run: (e) => query(`UPDATE events SET ${EVENT_COLS.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $9`, [...EVENT_COLS.map((k) => e[k]), e.id]),
  },
  deleteEvent: { run: (id) => query(`DELETE FROM events WHERE id = $1`, [Number(id)]) },

  // slots
  slotsForEvent: {
    all: (eventId) => query(`SELECT s.*, ${takenSql} AS taken,
        (SELECT COUNT(*)::int FROM bookings b WHERE b.slot_id = s.id AND b.status = 'paid') AS paid,
        (SELECT COUNT(*)::int FROM bookings b WHERE b.slot_id = s.id AND b.status = 'paid' AND b.checked_in_at IS NOT NULL) AS checked_in
      FROM slots s WHERE s.event_id = $1 ORDER BY s.start_time`, [Number(eventId)]),
  },
  slot: { get: (id) => one(`SELECT s.*, ${takenSql} AS taken FROM slots s WHERE s.id = $1`, [Number(id)]) },
  insertSlot: {
    run: async (s) => ({ lastInsertRowid: (await one(
      `INSERT INTO slots (event_id, ${SLOT_COLS.join(', ')}) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [s.event_id, ...SLOT_COLS.map((k) => s[k])])).id }),
  },
  updateSlot: {
    run: (s) => query(`UPDATE slots SET ${SLOT_COLS.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $6`, [...SLOT_COLS.map((k) => s[k]), s.id]),
  },
  deleteSlot: { run: (id) => query(`DELETE FROM slots WHERE id = $1`, [Number(id)]) },
  paidCountForSlot: { get: (id) => one(`SELECT COUNT(*)::int AS n FROM bookings WHERE slot_id = $1 AND status = 'paid'`, [Number(id)]) },
  paidCountForEvent: {
    get: (id) => one(`SELECT COUNT(*)::int AS n FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE s.event_id = $1 AND b.status = 'paid'`, [Number(id)]),
  },
  deleteUnpaidForSlot: { run: (id) => query(`DELETE FROM bookings WHERE slot_id = $1 AND status != 'paid'`, [Number(id)]) },
  deleteUnpaidForEvent: {
    run: (id) => query(`DELETE FROM bookings WHERE status != 'paid' AND slot_id IN (SELECT id FROM slots WHERE event_id = $1)`, [Number(id)]),
  },

  // bookings
  setSession: { run: (sessionId, orderId) => query(`UPDATE bookings SET payment_session_id = $1 WHERE order_id = $2`, [sessionId, orderId]) },
  bookingByOrder: { get: (orderId) => one(`SELECT * FROM bookings WHERE order_id = $1`, [orderId]) },
  bookingById: { get: (id) => one(`SELECT * FROM bookings WHERE id = $1`, [Number(id)]) },
  bookingByToken: { get: (token) => one(`SELECT * FROM bookings WHERE ticket_token = $1`, [token]) },
  paidForEmailSlot: {
    get: (slotId, email) => one(`SELECT id FROM bookings WHERE slot_id = $1 AND lower(email) = lower($2) AND status = 'paid'`, [Number(slotId), email]),
  },
  /** Returns { changes } like SQLite did, so callers can tell if this call flipped it to paid. */
  markPaid: {
    run: async (token, cfPaymentId, orderId) => ({
      changes: (await query(`UPDATE bookings SET status = 'paid', paid_at = now(), ticket_token = $1, cf_payment_id = $2
        WHERE order_id = $3 AND status != 'paid' RETURNING id`, [token, cfPaymentId, orderId])).length,
    }),
  },
  markFailed: { run: (orderId) => query(`UPDATE bookings SET status = 'failed' WHERE order_id = $1 AND status = 'pending'`, [orderId]) },
  emailOk: { run: (id) => query(`UPDATE bookings SET email_sent_at = now(), email_error = NULL WHERE id = $1`, [id]) },
  emailErr: { run: (msg, id) => query(`UPDATE bookings SET email_error = $1 WHERE id = $2`, [msg, id]) },
  checkIn: {
    run: async (id) => ({
      changes: (await query(`UPDATE bookings SET checked_in_at = now() WHERE id = $1 AND status = 'paid' AND checked_in_at IS NULL RETURNING id`, [Number(id)])).length,
    }),
  },
  undoCheckIn: { run: (id) => query(`UPDATE bookings SET checked_in_at = NULL WHERE id = $1`, [Number(id)]) },
  fullBooking: { get: (id) => one(`${fullBookingSql} WHERE b.id = $1`, [Number(id)]) },
};

/**
 * Inserts a pending booking only if the slot still has a free seat.
 * The advisory lock makes concurrent requests for the same slot take turns, so the last seat can't be sold twice.
 * Returns true if the seat was taken, false if the slot was full.
 */
async function insertBookingIfSeat(b) {
  const sql = client();
  const [, inserted] = await sql.transaction([
    sql.query(`SELECT pg_advisory_xact_lock(42, $1)`, [b.slot_id]),
    sql.query(`INSERT INTO bookings (order_id, slot_id, name, email, phone, amount, status)
      SELECT $1, s.id, $2, $3, $4, $5, 'pending' FROM slots s WHERE s.id = $6 AND ${takenSql} < s.capacity
      RETURNING id`, [b.order_id, b.name, b.email, b.phone, b.amount, b.slot_id]),
  ]);
  return inserted.length > 0;
}

async function searchBookings({ eventId, status, search }) {
  const where = [];
  const params = [];
  const p = (v) => { params.push(v); return `$${params.length}`; };
  if (eventId) where.push(`e.id = ${p(Number(eventId))}`);
  if (status === 'checked_in') where.push(`b.status = 'paid' AND b.checked_in_at IS NOT NULL`);
  else if (status === 'not_checked_in') where.push(`b.status = 'paid' AND b.checked_in_at IS NULL`);
  else if (status) where.push(`b.status = ${p(status)}`);
  if (search) {
    const s = p(`%${search}%`);
    where.push(`(b.name ILIKE ${s} OR b.email ILIKE ${s} OR b.phone ILIKE ${s} OR b.order_id ILIKE ${s} OR b.ticket_token ILIKE ${s})`);
  }
  return query(`${fullBookingSql} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.event_date DESC, s.start_time, b.created_at DESC LIMIT 2000`, params);
}

module.exports = { q, query, configured, ensureSchema, insertBookingIfSeat, searchBookings, HOLD_MINUTES };
