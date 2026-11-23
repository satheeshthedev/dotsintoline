(() => {
  const { api, esc, fmtDate, fmtRange, fmtStamp } = DIL;
  const resultEl = document.getElementById('result');
  const startBtn = document.getElementById('start');
  const flipBtn = document.getElementById('flip');
  const autoBox = document.getElementById('auto');
  const counterEl = document.getElementById('counter');

  let scanner = null;
  let running = false;
  let busy = false;
  let facing = 'environment';
  let lastCode = '';
  let lastAt = 0;
  let admitted = Number(sessionStorage.getItem('dil_admitted') || 0);
  counterEl.textContent = `${admitted} admitted`;

  try { autoBox.checked = localStorage.getItem('dil_auto') === '1'; } catch { /* ignore */ }
  autoBox.addEventListener('change', () => { try { localStorage.setItem('dil_auto', autoBox.checked ? '1' : '0'); } catch { /* ignore */ } });

  api('/api/admin/me').catch(() => { location.href = '/admin/login.html?next=/admin/scan.html'; });

  // ---------- feedback ----------
  let audio;
  function beep(ok) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.frequency.value = ok ? 880 : 220;
      o.type = ok ? 'sine' : 'square';
      g.gain.value = 0.12;
      o.connect(g).connect(audio.destination);
      o.start();
      o.stop(audio.currentTime + (ok ? 0.15 : 0.35));
    } catch { /* no audio */ }
    if (navigator.vibrate) navigator.vibrate(ok ? 80 : [120, 60, 120]);
  }

  // ---------- camera ----------
  async function startCamera() {
    if (typeof Html5Qrcode !== 'function') return DIL.toast('Scanner library failed to load. Check your connection.');
    document.getElementById('idle')?.remove();
    scanner = scanner || new Html5Qrcode('reader', { verbose: false });
    try {
      await scanner.start(
        { facingMode: facing },
        { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.72); return { width: s, height: s }; } },
        onDecode,
        () => {}
      );
      running = true;
      startBtn.textContent = '■ Stop camera';
      startBtn.classList.replace('red', 'soft');
      flipBtn.hidden = false;
    } catch (e) {
      const msg = String(e).includes('NotAllowed') ? 'Camera permission was denied. Allow camera access in your browser settings.'
        : location.protocol !== 'https:' && location.hostname !== 'localhost' ? 'Camera needs HTTPS. Open this page over https://'
        : 'Could not start the camera: ' + e;
      DIL.toast(msg);
    }
  }
  async function stopCamera() {
    if (scanner && running) await scanner.stop().catch(() => {});
    running = false;
    startBtn.textContent = '📷 Start camera';
    startBtn.classList.replace('soft', 'red');
    flipBtn.hidden = true;
  }
  startBtn.addEventListener('click', () => (running ? stopCamera() : startCamera()));
  flipBtn.addEventListener('click', async () => {
    facing = facing === 'environment' ? 'user' : 'environment';
    await stopCamera();
    startCamera();
  });

  function pauseScanner() { try { if (running) scanner.pause(true); } catch { /* ignore */ } }
  function resumeScanner() {
    busy = false;
    resultEl.className = 'result';
    try { if (running) scanner.resume(); } catch { /* ignore */ }
  }

  function onDecode(text) {
    if (busy) return;
    // ignore the same code re-read within 3s
    if (text === lastCode && Date.now() - lastAt < 3000) return;
    lastCode = text; lastAt = Date.now();
    verify(text);
  }

  // ---------- verify + admit ----------
  async function verify(code) {
    busy = true;
    pauseScanner();
    try {
      const r = await api('/api/admin/verify', { body: { code } });
      if (r.result === 'valid' && autoBox.checked) return admit(r.booking.id, r);
      show(r);
    } catch (e) {
      show({ result: 'invalid', message: e.status === 401 ? 'Logged out — please log in again.' : e.message });
    }
  }

  async function admit(id, r) {
    try {
      const res = await api(`/api/admin/bookings/${id}/checkin`, { method: 'POST' });
      if (res.alreadyCheckedIn) return show({ result: 'used', message: 'Already checked in.', booking: res.booking });
      admitted++;
      sessionStorage.setItem('dil_admitted', admitted);
      counterEl.textContent = `${admitted} admitted`;
      show({ result: 'admitted', message: 'Admitted — welcome in!', booking: res.booking, dateNote: r && r.dateNote });
      if (autoBox.checked) setTimeout(() => { if (resultEl.classList.contains('admitted')) resumeScanner(); }, 1800);
    } catch (e) {
      show({ result: 'invalid', message: e.message });
    }
  }

  const ICON = { valid: '✓', admitted: '✓', used: '⚠', invalid: '✕', unpaid: '✕' };
  const TITLE = { valid: 'Valid ticket', admitted: 'Admitted', used: 'Already used', invalid: 'Invalid ticket', unpaid: 'Not paid' };

  function show(r) {
    beep(r.result === 'valid' || r.result === 'admitted');
    const b = r.booking;
    resultEl.className = `result show ${r.result}`;
    resultEl.innerHTML = `
      <div class="big"><span>${ICON[r.result]}</span>${TITLE[r.result]}</div>
      ${b ? `<div class="who">${esc(b.name)}</div>
        <div class="meta">
          <span>${esc(b.event_title)} · ${fmtDate(b.event_date)}</span>
          <span>Slot: ${fmtRange(b.start_time, b.end_time)}${b.slot_label ? ` · ${esc(b.slot_label)}` : ''}</span>
          <span>${esc(b.email)} · ${esc(b.phone)}</span>
          <span class="mono">${esc(b.code)}</span>
          ${b.checked_in_at ? `<span><b>Checked in at ${fmtStamp(b.checked_in_at)}</b></span>` : ''}
        </div>` : `<div class="meta">${esc(r.message)}</div>`}
      ${r.dateNote ? `<div class="warn">⚠ ${esc(r.dateNote)}</div>` : ''}
      <div class="actions">
        ${r.result === 'valid' ? `<button class="btn white" data-admit="${b.id}">Admit</button><button class="btn clear" data-next>Cancel</button>`
          : `<button class="btn white" data-next>Scan next</button>`}
      </div>`;
    resultEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  resultEl.addEventListener('click', (e) => {
    const admitBtn = e.target.closest('[data-admit]');
    if (admitBtn) { admitBtn.disabled = true; return admit(Number(admitBtn.dataset.admit)); }
    if (e.target.closest('[data-next]')) resumeScanner();
  });

  document.getElementById('manual').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('code');
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    input.blur();
    verify(v);
  });
})();
