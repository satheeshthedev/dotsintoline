# Dots into Line — Meetup slot booking

Slot booking site for Dots into Line art meetups.

- **Public site** (`/`): upcoming meetups → pick a time slot → pay with **Cashfree** → ticket page with a QR code.
- **Email**: after payment, a QR ticket is emailed through **Brevo** (QR shown in the email and also attached as a PNG).
- **Admin** (`/admin/`): create events and slots (capacity, price), see bookings, export CSV, resend tickets, and check people in manually.
- **Scanner** (`/admin/scan.html`): open it on a phone at the entry, scan the QR, see the person's name and slot, then tap **Admit**. If a QR is scanned again, it shows **Already used** and the time of first check-in.

Stack: Node.js 22 + Express, SQLite (Node's built-in `node:sqlite`, stored in `data/dots.db`), plain HTML/CSS/JS.

## Run locally

```bash
npm install
cp .env.example .env      # then fill in the values
npm run seed              # optional: adds a sample meetup
npm start                 # http://localhost:3000  ·  admin: http://localhost:3000/admin/
```

Without Cashfree keys, only **free** slots (price 0) can be booked. Without a Brevo key, ticket emails are written to `data/outbox/` so you can open them in a browser.

## Cashfree setup
1. Sign up at the Cashfree Merchant Dashboard and go to **Developers → API Keys**. Copy the **App ID** and **Secret Key** into `CASHFREE_APP_ID` and `CASHFREE_SECRET_KEY`.
2. Keep `CASHFREE_ENV=sandbox` while testing (use Cashfree's test UPI or cards). Switch to `production` with your production keys when you go live.
3. **Webhook (recommended in production):** in **Developers → Webhooks**, add `https://YOUR-DOMAIN/api/payments/webhook`. The app also sends this URL with every order automatically when `BASE_URL` is https. The webhook confirms payments even if someone closes the browser before they're sent back to the site. Every webhook's signature is checked, and the order status is always re-fetched from Cashfree before a booking is marked paid.
4. In production, Cashfree only accepts return URLs from whitelisted domains. Add your domain under **Developers → Whitelisting**.

## Brevo setup
1. In Brevo, go to **SMTP & API → API Keys**, create a key, and put it in `BREVO_API_KEY`.
2. Verify the sender email/domain under **Senders, Domains & Dedicated IPs**, then set `MAIL_FROM_EMAIL` to that address.
3. Authenticate your domain (DKIM/DMARC) so tickets don't land in spam.

## How check-in works
- Each paid booking gets a random 12-character ticket code, e.g. `RWKN-0C1M-5KDF`. The QR contains `DIL:<code>`.
- Scanning a QR only **looks up** the ticket. The person is checked in when you tap **Admit**, or immediately if you turn on **Auto-admit** for fast entry.
- Results: **Valid** (green) · **Already used** (amber, with the first check-in time) · **Invalid / Not paid** (red). A warning appears if the ticket is for a different date.
- If someone has no phone or no network, type the code from their email into the box below the camera, or search for their name in **Admin → Bookings** and tap **Check in**.
- The camera only works over **HTTPS** (or on `localhost`).

## Deploying
Deploy to any host that runs Node 22+ with a **persistent disk** for `data/`, such as a VPS, Railway or Render with a disk attached. Hosts without a persistent disk would lose the database on every deploy.
- Set all `.env` values on the host. `BASE_URL` must be your public `https://` address.
- Use a strong `ADMIN_PASSWORD` and a random `SESSION_SECRET`.
- Back up `data/dots.db` regularly.

## Booking rules (built in)
- A seat is held for `HOLD_MINUTES` (default 20) while someone pays. Unpaid holds free up automatically after that.
- The same email can't book the same slot twice.
- A slot can't be deleted, and its price can't change, once someone has paid. Unpublish the event instead.
- Phone numbers must be valid 10-digit Indian mobile numbers (Cashfree requires a phone number).

## Customising
- Logo: replace `public/img/logo.svg`, or drop your own `logo.png` in and update the `<img>` tags.
- Event posters: put images in `public/img/posters/` and set the event's poster URL to `/img/posters/your-file.jpg`.
- Colours and fonts: the variables at the top of `public/css/style.css`.
