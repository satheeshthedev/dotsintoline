// Adds a meetup to the database. Edit the details below, then run: npm run seed
require('dotenv').config({ quiet: true });
const { q, ensureSchema } = require('./db');

(async () => {
  await ensureSchema();
  const { lastInsertRowid: eventId } = await q.insertEvent.run({
    title: 'Art Meetup',
    description: 'An evening of making art together. Bring your sketchbook, colours or anything you love to create with. No rules, no pressure, just art.',
    venue: 'Rock Beach, Puducherry',
    map_url: 'https://maps.google.com/?q=Rock+Beach+Puducherry',
    event_date: '2026-12-02', // YYYY-MM-DD
    poster_url: '',
    what_to_bring: '',
    published: 1,
  });
  await q.insertSlot.run({ event_id: eventId, label: 'Evening session', start_time: '19:00', end_time: '22:00', capacity: 30, price: 149 });
  console.log(`Added meetup #${eventId}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
