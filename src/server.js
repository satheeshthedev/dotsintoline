// Local development server: npm start
const app = require('./app');
const cashfree = require('./cashfree');

const PORT = Number(process.env.PORT || 3000);

app.listen(PORT, () => {
  console.log(`Dots into Line running at ${app.BASE_URL}  (admin: ${app.BASE_URL}/admin/)`);
  if (!process.env.DATABASE_URL && !process.env.NETLIFY_DATABASE_URL && !process.env.POSTGRES_URL) console.warn('[db] DATABASE_URL not set — add your Neon Postgres connection string to .env');
  if (!cashfree.configured()) console.warn('[cashfree] CASHFREE_APP_ID / CASHFREE_SECRET_KEY not set — only free slots can be booked.');
  if (!process.env.BREVO_API_KEY) console.warn('[mail] BREVO_API_KEY not set — ticket emails are only logged, not sent.');
  if (!process.env.ADMIN_PASSWORD) console.warn('[auth] ADMIN_PASSWORD not set — admin login is disabled.');
});
