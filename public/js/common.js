// Shared helpers for public + admin pages
const DIL = (() => {
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      method: opts.method || (opts.body ? 'POST' : 'GET'),
      headers: opts.body ? { 'content-type': 'application/json' } : {},
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function parseDate(ymd) {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const fmtDate = (ymd, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) =>
    parseDate(ymd).toLocaleDateString('en-IN', opts);
  function fmtTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  }
  const fmtRange = (a, b) => `${fmtTime(a)} – ${fmtTime(b)}`;
  const rupees = (n) => (n > 0 ? `₹${Number(n).toLocaleString('en-IN')}` : 'Free');

  /** SQLite "YYYY-MM-DD HH:MM:SS" (UTC) → local readable */
  function fmtStamp(s) {
    if (!s) return '';
    // Postgres sends ISO strings ("2026-11-23T10:00:00.000Z"); older data may be "YYYY-MM-DD HH:MM:SS" (UTC)
    const d = new Date(String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z');
    return d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  }

  let toastTimer;
  function toast(msg) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  return { api, esc, fmtDate, fmtTime, fmtRange, rupees, fmtStamp, toast, parseDate };
})();
