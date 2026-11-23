const crypto = require('crypto');

const COOKIE = 'dil_admin';
const SESSION_HOURS = 12;

let secret = process.env.SESSION_SECRET;
if (!secret || secret.startsWith('replace-')) {
  // Serverless hosts run many short-lived copies, so the secret must be identical in all of them.
  // Fall back to one derived from the admin password (set SESSION_SECRET in production).
  secret = crypto.createHash('sha256').update('dil-session:' + (process.env.ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex'))).digest('hex');
  console.warn('[auth] SESSION_SECRET not set — deriving one from ADMIN_PASSWORD.');
}

const sign = (v) => crypto.createHmac('sha256', secret).update(v).digest('base64url');

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((p) => p.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

function isAdmin(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return false;
  const [exp, sig] = token.split('.');
  return Boolean(exp && sig) && safeEqual(sig, sign(exp)) && Number(exp) > Date.now();
}

function setSession(req, res) {
  const exp = String(Date.now() + SESSION_HOURS * 3600 * 1000);
  const secure = req.secure ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

// Simple in-memory brute-force guard: 10 failed attempts per IP per 15 minutes.
const attempts = new Map();
function loginAllowed(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.reset < now) return true;
  return rec.count < 10;
}
function recordFailure(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.reset < now) attempts.set(ip, { count: 1, reset: now + 15 * 60 * 1000 });
  else rec.count++;
}

function checkPassword(pw) {
  const expected = process.env.ADMIN_PASSWORD;
  return Boolean(expected) && safeEqual(pw || '', expected);
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  res.status(401).json({ error: 'Not logged in' });
}

module.exports = { isAdmin, setSession, clearSession, loginAllowed, recordFailure, checkPassword, requireAdmin };
