(() => {
  const { api, esc, fmtDate, fmtRange } = DIL;
  const root = document.getElementById('root');
  const orderId = new URLSearchParams(location.search).get('order_id');
  let polls = 0;

  const details = (b) => `
    <dl class="ticket-details">
      <div><dt>Event</dt><dd>${esc(b.event.title)}</dd></div>
      <div><dt>Date</dt><dd>${fmtDate(b.event.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</dd></div>
      <div><dt>Slot</dt><dd>${fmtRange(b.slot.start_time, b.slot.end_time)}${b.slot.label ? ` · ${esc(b.slot.label)}` : ''}</dd></div>
      ${b.event.venue ? `<div><dt>Venue</dt><dd>${b.event.map_url ? `<a href="${esc(b.event.map_url)}" target="_blank" rel="noopener">${esc(b.event.venue)}</a>` : esc(b.event.venue)}</dd></div>` : ''}
      <div><dt>Name</dt><dd>${esc(b.name)}</dd></div>
      ${b.event.what_to_bring ? `<div><dt>Bring</dt><dd style="font-weight:500">${esc(b.event.what_to_bring)}</dd></div>` : ''}
    </dl>`;

  function render(b) {
    if (b.status === 'paid') {
      root.innerHTML = `
        <div class="ticket">
          <div class="ticket-top">
            <div class="status-icon ok">✓</div>
            <h1>You're in, ${esc(b.name.split(' ')[0])}!</h1>
            <p>Show this QR at the entry. ${b.emailSent ? `We've also emailed it to <b>${esc(b.email)}</b>.` : `It's being emailed to <b>${esc(b.email)}</b>.`}</p>
          </div>
          <div class="ticket-qr">
            <img src="${b.ticket.qr}" alt="Entry QR code">
            <div class="ticket-code">${esc(b.ticket.code)}</div>
          </div>
          <div class="perf"></div>
          ${details(b)}
        </div>
        <div class="ticket-actions">
          <a class="btn" href="${b.ticket.qr}" download="DotsIntoLine-ticket-${esc(b.ticket.code)}.png">Download QR</a>
          <a class="btn ghost" href="/">Back to meetups</a>
        </div>
        <p class="notice" style="max-width:440px;margin:16px auto 0">Tip: take a screenshot of this QR, just in case there's no network at the venue.</p>`;
      return;
    }

    root.innerHTML = `
      <div class="ticket"><div class="ticket-top">
        <div class="status-icon bad">✕</div>
        <h1>Not confirmed</h1>
        <p>This registration wasn't completed and no ticket was issued. Please register again.</p>
      </div><div class="perf"></div>${details(b)}</div>
      <div class="ticket-actions"><a class="btn" href="/#meetups">Register again</a></div>`;
  }

  async function check() {
    try {
      const b = await api(`/api/bookings/${encodeURIComponent(orderId)}`);
      render(b);
      if (b.status === 'paid' && !b.emailSent && polls++ < 8) setTimeout(check, 3000);
    } catch (e) {
      root.innerHTML = `<div class="ticket"><div class="ticket-top"><div class="status-icon bad">?</div>
        <h1>Booking not found</h1><p>${esc(e.message)}</p></div></div>
        <div class="ticket-actions"><a class="btn" href="/">Back to meetups</a></div>`;
    }
  }

  if (!orderId) {
    location.replace('/');
  } else {
    check();
  }
})();
