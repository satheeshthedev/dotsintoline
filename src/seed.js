// Creates the tables and copies the hard-coded meetups from src/meetups.js into an empty database.
// (This also happens automatically on the first request.) Run: npm run seed
require('dotenv').config({ quiet: true });
const { ensureSchema } = require('./db');

ensureSchema()
  .then(() => console.log('Database ready.'))
  .catch((e) => { console.error(e.message); process.exit(1); });
