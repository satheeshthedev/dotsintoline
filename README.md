# Dots into Line — Meetup registration (Phase 1)

Free registration site for Dots into Line art meetups.

- **Site** (`/`): upcoming meetups → tap **Register** on a time slot → fill in name, email and mobile → confirmed.
- **Ticket**: a QR ticket is shown on screen and emailed through **Brevo**.
- Seats per slot are limited, and the same email can't register twice for one slot.

> **Phase 2** (branch `phase-2`) adds Cashfree payments, the admin dashboard and the QR check-in scanner.

Stack: Node.js 22 + Express, SQLite (`node:sqlite`, stored in `data/dots.db`), plain HTML/CSS/JS.

## Run locally

```bash
npm install
cp .env.example .env      # add your Brevo key + sender email
npm run seed              # adds a sample meetup
npm start                 # http://localhost:3000
```

Without a Brevo key, ticket emails are written to `data/outbox/` so you can open them in a browser.

## Brevo setup
1. In Brevo, open **SMTP & API → API Keys**, create a key and put it in `BREVO_API_KEY`.
2. Verify your sender under **Senders, Domains & Dedicated IPs** and set `MAIL_FROM_EMAIL`.

## Adding meetups
Phase 1 has no admin panel. Edit `src/seed.js` with your meetup's details (title, date, venue, slots) and run `npm run seed`.

## Customising
- Logo: `public/img/logo.svg`
- Colours and fonts: variables at the top of `public/css/style.css`
