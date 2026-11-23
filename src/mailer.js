// Brevo transactional email — https://developers.brevo.com/reference/sendtransacemail
const fs = require('fs');
const path = require('path');

async function sendEmail({ to, toName, subject, html, attachments = [] }) {
  if (!process.env.BREVO_API_KEY) {
    // Dev fallback: write the email to data/outbox so you can open it in a browser.
    // (Serverless hosts have a read-only disk, so there we only log it.)
    const dir = path.join(__dirname, '..', 'data', 'outbox');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {
      console.warn(`[mail] BREVO_API_KEY not set — email to ${to} not sent`);
      return { messageId: 'not-sent' };
    }
    const file = path.join(dir, `${Date.now()}-${to.replace(/[^a-z0-9]/gi, '_')}.html`);
    fs.writeFileSync(file, html);
    for (const a of attachments) fs.writeFileSync(file.replace(/\.html$/, `-${a.name}`), Buffer.from(a.content, 'base64'));
    console.warn(`[mail] BREVO_API_KEY not set — email to ${to} saved to ${file}`);
    return { messageId: 'dev-outbox' };
  }

  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: process.env.MAIL_FROM_EMAIL, name: process.env.MAIL_FROM_NAME || 'Dots into Line' },
      to: [{ email: to, name: toName }],
      subject,
      htmlContent: html,
      attachment: attachments.length ? attachments : undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${data.message || 'send failed'}`);
  return data;
}

module.exports = { sendEmail };
