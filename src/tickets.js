const crypto = require('crypto');
const QRCode = require('qrcode');
const { sendEmail } = require('./mailer');
const { q } = require('./db');

const QR_PREFIX = 'DIL:';
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U

/** 12-char random ticket code (60 bits). Shown to humans as XXXX-XXXX-XXXX. */
function newTicketToken() {
  return Array.from(crypto.randomBytes(12), (b) => ALPHABET[b & 31]).join('');
}

/** Accepts raw QR text ("DIL:ABCD…"), a typed code with dashes/spaces, or lowercase. */
function normalizeCode(input) {
  let s = String(input || '').trim();
  if (s.toUpperCase().startsWith(QR_PREFIX)) s = s.slice(QR_PREFIX.length);
  s = s.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === 12 ? s : null;
}

const prettyCode = (t) => (t ? t.match(/.{1,4}/g).join('-') : '');

const qrOptions = { width: 480, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#1f1b16', light: '#ffffff' } };
const qrPng = (token) => QRCode.toBuffer(QR_PREFIX + token, qrOptions);
const qrDataUrl = (token) => QRCode.toDataURL(QR_PREFIX + token, qrOptions);

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function formatDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}

function formatTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}

function ticketEmailHtml(b, baseUrl) {
  // Gmail fetches images from its own servers, so a localhost (or blocked) URL shows as a broken image.
  // The PNG is attached and referenced here so the QR renders inside the message.
  const statusUrl = `${baseUrl}/status.html?order_id=${encodeURIComponent(b.order_id)}`;
  const slot = `${formatTime(b.start_time)} – ${formatTime(b.end_time)}${b.slot_label ? ` · ${esc(b.slot_label)}` : ''}`;
  const insta = process.env.INSTAGRAM_URL || 'https://www.instagram.com/dots.into_line/';
  const row = (k, v) => `<tr><td style="padding:6px 0;color:#7a6f60;font-size:13px;width:90px;vertical-align:top">${k}</td>
      <td style="padding:6px 0;color:#1f1b16;font-size:15px;font-weight:600">${v}</td></tr>`;

  return `<!doctype html><html><body style="margin:0;background:#f6efe3;font-family:Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6efe3;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf8;border-radius:18px;border:1px solid #e8dcc6">
  <tr><td style="padding:28px 28px 8px;text-align:center">
    <div style="font-size:13px;letter-spacing:3px;color:#7a6f60">DOTS INTO LINE · ART COMMUNITY</div>
    <h1 style="margin:10px 0 4px;font-size:26px;color:#1f1b16">You're in, ${esc(b.name.split(' ')[0])}! 🎨</h1>
    <p style="margin:0;color:#5b5246;font-size:15px">Your spot is confirmed. Show this QR at the entry.</p>
  </td></tr>
  <tr><td style="padding:18px 28px;text-align:center">
    <img src="cid:ticket-qr.png" width="240" height="240" alt="Your entry QR code" style="display:block;margin:0 auto;border:1px solid #e8dcc6;border-radius:12px">
    <div style="margin-top:10px;font-family:'Courier New',monospace;font-size:20px;letter-spacing:2px;color:#1f1b16;font-weight:700">${prettyCode(b.ticket_token)}</div>
    <div style="font-size:12px;color:#7a6f60;margin-top:4px">QR not showing? It's also attached to this email.</div>
  </td></tr>
  <tr><td style="padding:4px 28px 8px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px dashed #d9c9ab;padding-top:10px">
      ${row('Event', esc(b.event_title))}
      ${row('Date', formatDate(b.event_date))}
      ${row('Slot', slot)}
      ${row('Venue', b.map_url ? `<a href="${esc(b.map_url)}" style="color:#c2462e">${esc(b.venue)}</a>` : esc(b.venue))}
      ${row('Name', esc(b.name))}
      ${row('Paid', b.amount > 0 ? `₹${b.amount}` : 'Free')}
    </table>
  </td></tr>
  ${b.what_to_bring ? `<tr><td style="padding:6px 28px"><div style="background:#f6efe3;border-radius:12px;padding:12px 14px;font-size:14px;color:#5b5246"><b style="color:#1f1b16">Bring along:</b> ${esc(b.what_to_bring)}</div></td></tr>` : ''}
  <tr><td style="padding:16px 28px 26px;text-align:center;font-size:13px;color:#7a6f60">
    <a href="${statusUrl}" style="color:#c2462e">View your ticket online</a> · <a href="${insta}" style="color:#c2462e">@dots.into_line</a><br><br>
    No experience needed. No pressure, just create. ✦
  </td></tr>
</table>
</td></tr></table></body></html>`;
}

/** Sends the QR ticket email for a paid booking id. Records success/failure on the booking. */
async function sendTicketEmail(bookingId, baseUrl) {
  const b = await q.fullBooking.get(bookingId);
  if (!b || b.status !== 'paid' || !b.ticket_token) throw new Error('Booking is not paid');
  try {
    const png = await qrPng(b.ticket_token);
    await sendEmail({
      to: b.email,
      toName: b.name,
      subject: `Your ticket: ${b.event_title} · ${formatDate(b.event_date)}`,
      html: ticketEmailHtml(b, baseUrl),
      attachments: [{ name: 'ticket-qr.png', content: png.toString('base64') }],
    });
    await q.emailOk.run(bookingId);
  } catch (err) {
    await q.emailErr.run(String(err.message).slice(0, 500), bookingId).catch(() => {});
    throw err;
  }
}

module.exports = { newTicketToken, normalizeCode, prettyCode, qrPng, qrDataUrl, sendTicketEmail, formatDate, formatTime };
