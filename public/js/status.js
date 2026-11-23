(() => {
  const { api, esc, fmtDate, fmtRange, rupees } = DIL;
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
      <div><dt>Amount</dt><dd>${rupees(b.amount)}</dd></div>
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

    if (b.status === 'pending') {
      const stillChecking = polls < 6;
      root.innerHTML = `
        <div class="ticket"><div class="ticket-top">
          <div class="status-icon wait">${stillChecking ? '<div class="spinner"></div>' : '!'}</div>
          <h1>${stillChecking ? 'Confirming…' : 'Payment not completed'}</h1>
          <p>${stillChecking ? 'Hang on, we are confirming your payment.' : 'We haven’t received your payment yet. If money was debited, it will be confirmed automatically in a few minutes — refresh this page.'}</p>
        </div>
        <div class="perf"></div>${details(b)}</div>
        ${stillChecking ? '' : `<div class="ticket-actions">
          <button class="btn" id="retry">Try paying again</button>
          <button class="btn ghost" onclick="location.reload()">Refresh status</button>
        </div>`}`;
      const retry = document.getElementById('retry');
      if (retry) retry.addEventListener('click', () => retryPayment(retry));
      return;
    }

    root.innerHTML = `
      <div class="ticket"><div class="ticket-top">
        <div class="status-icon bad">✕</div>
        <h1>Payment failed</h1>
        <p>This booking wasn't completed and no ticket was issued. If money was debited, it will be refunded by your bank.</p>
      </div><div class="perf"></div>${details(b)}</div>
      <div class="ticket-actions"><a class="btn" href="/#meetups">Book again</a></div>`;
  }

  async function retryPayment(btn) {
    btn.disabled = true;
    try {
      const [{ cashfreeMode }, { paymentSessionId }] = await Promise.all([
        api('/api/config'),
        api(`/api/bookings/${encodeURIComponent(orderId)}/retry`, { method: 'POST' }),
      ]);
      await Cashfree({ mode: cashfreeMode }).checkout({ paymentSessionId, redirectTarget: '_self' });
    } catch (e) {
      DIL.toast(e.message);
      btn.disabled = false;
    }
  }

  async function check() {
    try {
      const b = await api(`/api/bookings/${encodeURIComponent(orderId)}`);
      render(b);
      if (b.status === 'pending' && polls++ < 6) setTimeout(check, 2500);
      else if (b.status === 'paid' && !b.emailSent && polls++ < 8) setTimeout(check, 3000);
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
