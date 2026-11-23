const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(process.env.DB_PATH || path.join(dataDir, 'dots.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  venue         TEXT NOT NULL DEFAULT '',
  map_url       TEXT NOT NULL DEFAULT '',
  event_date    TEXT NOT NULL,             -- YYYY-MM-DD (IST)
  poster_url    TEXT NOT NULL DEFAULT '',
  what_to_bring TEXT NOT NULL DEFAULT '',
  published     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  label       TEXT NOT NULL DEFAULT '',
  start_time  TEXT NOT NULL,               -- HH:MM
  end_time    TEXT NOT NULL,               -- HH:MM
  capacity    INTEGER NOT NULL,
  price       INTEGER NOT NULL DEFAULT 0   -- whole rupees; 0 = free
);

CREATE TABLE IF NOT EXISTS bookings (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id           TEXT NOT NULL UNIQUE,
  slot_id            INTEGER NOT NULL REFERENCES slots(id),
  name               TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT NOT NULL,
  amount             INTEGER NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',   -- pending | paid | failed
  payment_session_id TEXT,
  cf_payment_id      TEXT,
  ticket_token       TEXT UNIQUE,
  email_sent_at      TEXT,
  email_error        TEXT,
  checked_in_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at            TEXT
);

CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id, status);
CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);
`);

const HOLD_MINUTES = Number(process.env.HOLD_MINUTES || 20);
const takenSql = `(SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND
   (b.status = 'paid' OR (b.status = 'pending' AND b.created_at > datetime('now', '-${HOLD_MINUTES} minutes'))))`;

const q = {
  // events
  publicEvents: db.prepare(`SELECT * FROM events WHERE published = 1 AND event_date >= ? ORDER BY event_date`),
  allEvents: db.prepare(`SELECT * FROM events ORDER BY event_date DESC`),
  event: db.prepare(`SELECT * FROM events WHERE id = ?`),
  insertEvent: db.prepare(`INSERT INTO events (title, description, venue, map_url, event_date, poster_url, what_to_bring, published)
    VALUES (:title, :description, :venue, :map_url, :event_date, :poster_url, :what_to_bring, :published)`),
  updateEvent: db.prepare(`UPDATE events SET title=:title, description=:description, venue=:venue, map_url=:map_url,
    event_date=:event_date, poster_url=:poster_url, what_to_bring=:what_to_bring, published=:published WHERE id=:id`),
  deleteEvent: db.prepare(`DELETE FROM events WHERE id = ?`),

  // slots
  slotsForEvent: db.prepare(`SELECT s.*, ${takenSql} AS taken,
      (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'paid') AS paid,
      (SELECT COUNT(*) FROM bookings b WHERE b.slot_id = s.id AND b.status = 'paid' AND b.checked_in_at IS NOT NULL) AS checked_in
    FROM slots s WHERE s.event_id = ? ORDER BY s.start_time`),
  slot: db.prepare(`SELECT s.*, ${takenSql} AS taken FROM slots s WHERE s.id = ?`),
  insertSlot: db.prepare(`INSERT INTO slots (event_id, label, start_time, end_time, capacity, price)
    VALUES (:event_id, :label, :start_time, :end_time, :capacity, :price)`),
  updateSlot: db.prepare(`UPDATE slots SET label=:label, start_time=:start_time, end_time=:end_time, capacity=:capacity, price=:price WHERE id=:id`),
  deleteSlot: db.prepare(`DELETE FROM slots WHERE id = ?`),
  paidCountForSlot: db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE slot_id = ? AND status = 'paid'`),
  paidCountForEvent: db.prepare(`SELECT COUNT(*) AS n FROM bookings b JOIN slots s ON s.id = b.slot_id WHERE s.event_id = ? AND b.status = 'paid'`),
  deleteUnpaidForSlot: db.prepare(`DELETE FROM bookings WHERE slot_id = ? AND status != 'paid'`),
  deleteUnpaidForEvent: db.prepare(`DELETE FROM bookings WHERE status != 'paid' AND slot_id IN (SELECT id FROM slots WHERE event_id = ?)`),

  // bookings
  insertBooking: db.prepare(`INSERT INTO bookings (order_id, slot_id, name, email, phone, amount, status)
    VALUES (:order_id, :slot_id, :name, :email, :phone, :amount, 'pending')`),
  setSession: db.prepare(`UPDATE bookings SET payment_session_id = ? WHERE order_id = ?`),
  bookingByOrder: db.prepare(`SELECT * FROM bookings WHERE order_id = ?`),
  bookingById: db.prepare(`SELECT * FROM bookings WHERE id = ?`),
  bookingByToken: db.prepare(`SELECT * FROM bookings WHERE ticket_token = ?`),
  paidForEmailSlot: db.prepare(`SELECT id FROM bookings WHERE slot_id = ? AND lower(email) = lower(?) AND status = 'paid'`),
  markPaid: db.prepare(`UPDATE bookings SET status = 'paid', paid_at = datetime('now'), ticket_token = ?, cf_payment_id = ?
    WHERE order_id = ? AND status != 'paid'`),
  markFailed: db.prepare(`UPDATE bookings SET status = 'failed' WHERE order_id = ? AND status = 'pending'`),
  emailOk: db.prepare(`UPDATE bookings SET email_sent_at = datetime('now'), email_error = NULL WHERE id = ?`),
  emailErr: db.prepare(`UPDATE bookings SET email_error = ? WHERE id = ?`),
  checkIn: db.prepare(`UPDATE bookings SET checked_in_at = datetime('now') WHERE id = ? AND status = 'paid' AND checked_in_at IS NULL`),
  undoCheckIn: db.prepare(`UPDATE bookings SET checked_in_at = NULL WHERE id = ?`),
};

/** Full booking info joined with its slot + event. */
const fullBookingSql = `SELECT b.*, s.label AS slot_label, s.start_time, s.end_time, s.price,
    e.id AS event_id, e.title AS event_title, e.event_date, e.venue, e.map_url, e.what_to_bring
  FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN events e ON e.id = s.event_id`;
q.fullBooking = db.prepare(`${fullBookingSql} WHERE b.id = ?`);

function searchBookings({ eventId, status, search }) {
  const where = [];
  const params = {};
  if (eventId) { where.push('e.id = :eventId'); params.eventId = Number(eventId); }
  if (status === 'checked_in') where.push(`b.status = 'paid' AND b.checked_in_at IS NOT NULL`);
  else if (status === 'not_checked_in') where.push(`b.status = 'paid' AND b.checked_in_at IS NULL`);
  else if (status) { where.push('b.status = :status'); params.status = status; }
  if (search) {
    where.push(`(b.name LIKE :s OR b.email LIKE :s OR b.phone LIKE :s OR b.order_id LIKE :s OR b.ticket_token LIKE :s)`);
    params.s = `%${search}%`;
  }
  const sql = `${fullBookingSql} ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY e.event_date DESC, s.start_time, b.created_at DESC LIMIT 2000`;
  return db.prepare(sql).all(params);
}

module.exports = { db, q, searchBookings, HOLD_MINUTES };
