(() => {
  const { api, esc, fmtDate, fmtRange, rupees, fmtStamp, toast } = DIL;
  const state = { events: [], today: '', editingEvent: null, editingSlot: null, slotEventId: null };

  // ---------- auth ----------
  async function guard() {
    try {
      const me = await api('/api/admin/me');
      state.today = me.today;
      const warn = [];
      if (!me.cashfree) warn.push('Cashfree keys are not set — paid slots cannot be booked.');
      if (!me.brevo) warn.push('Brevo API key is not set — ticket emails are saved to data/outbox instead of being sent.');
      if (warn.length) document.getElementById('setup-warn').innerHTML =
        `<div class="panel" style="margin-top:18px;border-color:var(--yellow);background:#fdf6e3">⚠️ ${warn.map(esc).join('<br>⚠️ ')}</div>`;
    } catch {
      location.href = '/admin/login.html?next=' + encodeURIComponent(location.pathname);
      throw new Error('redirect');
    }
  }
  document.getElementById('logout').addEventListener('click', async () => {
    await api('/api/admin/logout', { method: 'POST' });
    location.href = '/admin/login.html';
  });

  // ---------- tabs ----------
  const tabs = document.querySelectorAll('[data-tab]');
  function showTab(name) {
    tabs.forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('[data-panel]').forEach((p) => (p.hidden = p.dataset.panel !== name));
    try { sessionStorage.setItem('dil_tab', name); } catch { /* ignore */ }
    if (name === 'bookings') loadBookings();
  }
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // ---------- dialogs ----------
  document.querySelectorAll('dialog').forEach((d) =>
    d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-close]')) d.close(); })
  );
  function formError(form, msg) {
    const el = form.querySelector('[data-err]');
    el.textContent = msg || '';
    el.classList.toggle('show', Boolean(msg));
  }

  // ---------- data ----------
  async function loadEvents() {
    state.events = await api('/api/admin/events');
    renderOverview();
    renderEvents();
    const sel = document.getElementById('b-event');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All events</option>' +
      state.events.map((e) => `<option value="${e.id}">${esc(fmtDate(e.event_date))} · ${esc(e.title)}</option>`).join('');
    sel.value = cur;
  }

  function renderOverview() {
    const upcoming = state.events.filter((e) => e.event_date >= state.today).sort((a, b) => a.event_date.localeCompare(b.event_date));
    let paid = 0, inside = 0, revenue = 0, capacity = 0;
    for (const e of upcoming) for (const s of e.slots) { paid += s.paid; inside += s.checked_in; revenue += s.paid * s.price; capacity += s.capacity; }

    const el = document.getElementById('overview');
    el.innerHTML = `
      <div class="stats">
        <div class="stat"><div class="k">Upcoming events</div><div class="v">${upcoming.length}</div></div>
        <div class="stat"><div class="k">Confirmed spots</div><div class="v">${paid}<span class="muted"> / ${capacity}</span></div></div>
        <div class="stat"><div class="k">Checked in</div><div class="v">${inside}</div></div>
        <div class="stat"><div class="k">Revenue</div><div class="v">₹${revenue.toLocaleString('en-IN')}</div></div>
      </div>
      ${upcoming.length ? upcoming.map((e) => `
        <div class="panel">
          <div class="panel-head">
            <div><h3>${esc(e.title)} ${e.published ? '' : '<span class="badge draft">Draft</span>'} ${e.event_date === state.today ? '<span class="badge in">Today</span>' : ''}</h3>
            <div class="sub">${fmtDate(e.event_date, { weekday: 'long', day: 'numeric', month: 'long' })} · ${esc(e.venue)}</div></div>
            <a class="btn sm" href="/admin/scan.html">Scan entries</a>
          </div>
          <div class="table-scroll"><table class="data">
            <tr><th>Slot</th><th class="num">Booked</th><th class="num">Checked in</th><th style="width:30%">Fill</th><th class="num">Revenue</th></tr>
            ${e.slots.map((s) => `<tr>
              <td><b>${fmtRange(s.start_time, s.end_time)}</b><div class="muted">${esc(s.label)} · ${rupees(s.price)}</div></td>
              <td class="num">${s.paid} / ${s.capacity}${s.taken > s.paid ? `<div class="muted">+${s.taken - s.paid} paying</div>` : ''}</td>
              <td class="num">${s.checked_in}</td>
              <td><div class="bar" title="${s.checked_in} in · ${s.paid} paid · ${s.capacity} capacity">
                <i class="in" style="width:${(s.checked_in / s.capacity) * 100}%"></i>
                <i class="paid" style="width:${((s.paid - s.checked_in) / s.capacity) * 100}%"></i></div></td>
              <td class="num">₹${(s.paid * s.price).toLocaleString('en-IN')}</td>
            </tr>`).join('') || '<tr><td colspan="5" class="muted">No slots yet.</td></tr>'}
          </table></div>
        </div>`).join('') : '<div class="empty"><h3>No upcoming events</h3><p>Create one in the “Events &amp; slots” tab.</p></div>'}`;
  }

  function renderEvents() {
    const el = document.getElementById('event-list');
    if (!state.events.length) {
      el.innerHTML = '<div class="empty"><h3>No events yet</h3><p>Click “New event” to create your first meetup.</p></div>';
      return;
    }
    el.innerHTML = state.events.map((e) => `
      <div class="panel" ${e.event_date < state.today ? 'style="opacity:.7"' : ''}>
        <div class="panel-head">
          <div>
            <h3>${esc(e.title)} ${e.published ? '' : '<span class="badge draft">Draft</span>'} ${e.event_date < state.today ? '<span class="badge draft">Past</span>' : ''}</h3>
            <div class="sub">${fmtDate(e.event_date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${esc(e.venue)}</div>
          </div>
          <div class="row-actions">
            <button class="btn soft sm" data-act="add-slot" data-id="${e.id}">+ Slot</button>
            <button class="btn ghost sm" data-act="edit-event" data-id="${e.id}">Edit</button>
            <button class="btn ghost sm" data-act="del-event" data-id="${e.id}">Delete</button>
          </div>
        </div>
        <div class="slot-list">
          ${e.slots.map((s) => `<div class="slot-row">
            <div><div class="t">${fmtRange(s.start_time, s.end_time)}</div><div class="muted">${esc(s.label) || '—'}</div></div>
            <div>${rupees(s.price)}</div>
            <div class="muted">${s.paid} booked · ${s.capacity} capacity · ${s.checked_in} in</div>
            <div class="row-actions">
              <button class="btn ghost sm" data-act="edit-slot" data-id="${s.id}" data-event="${e.id}">Edit</button>
              <button class="btn ghost sm" data-act="del-slot" data-id="${s.id}">✕</button>
            </div>
          </div>`).join('') || '<div class="muted">No slots yet — add one so people can book.</div>'}
        </div>
      </div>`).join('');
  }

  // ---------- event + slot editing ----------
  const eventDialog = document.getElementById('event-dialog');
  const eventForm = document.getElementById('event-form');
  const slotDialog = document.getElementById('slot-dialog');
  const slotForm = document.getElementById('slot-form');

  function openEvent(ev) {
    state.editingEvent = ev ? ev.id : null;
    document.getElementById('event-dialog-title').textContent = ev ? 'Edit event' : 'New event';
    eventForm.reset();
    for (const k of ['title', 'event_date', 'venue', 'map_url', 'poster_url', 'description', 'what_to_bring']) eventForm.elements[k].value = ev ? ev[k] : '';
    eventForm.elements.published.checked = ev ? Boolean(ev.published) : true;
    formError(eventForm);
    eventDialog.showModal();
  }
  function openSlot(eventId, slot) {
    state.slotEventId = eventId;
    state.editingSlot = slot ? slot.id : null;
    document.getElementById('slot-dialog-title').textContent = slot ? 'Edit slot' : 'New slot';
    slotForm.reset();
    if (slot) for (const k of ['label', 'start_time', 'end_time', 'capacity', 'price']) slotForm.elements[k].value = slot[k];
    formError(slotForm);
    slotDialog.showModal();
  }

  document.getElementById('new-event').addEventListener('click', () => openEvent(null));

  eventForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = eventForm.elements;
    const body = {
      title: f.title.value, event_date: f.event_date.value, venue: f.venue.value, map_url: f.map_url.value,
      poster_url: f.poster_url.value, description: f.description.value, what_to_bring: f.what_to_bring.value, published: f.published.checked,
    };
    try {
      if (state.editingEvent) await api(`/api/admin/events/${state.editingEvent}`, { method: 'PUT', body });
      else {
        const { id } = await api('/api/admin/events', { body });
        eventDialog.close();
        await loadEvents();
        toast('Event created — now add a slot');
        return openSlot(id, null);
      }
      eventDialog.close();
      toast('Event saved');
      loadEvents();
    } catch (err) { formError(eventForm, err.message); }
  });

  slotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = slotForm.elements;
    const body = { label: f.label.value, start_time: f.start_time.value, end_time: f.end_time.value, capacity: Number(f.capacity.value), price: Number(f.price.value) };
    try {
      if (state.editingSlot) await api(`/api/admin/slots/${state.editingSlot}`, { method: 'PUT', body });
      else await api(`/api/admin/events/${state.slotEventId}/slots`, { body });
      slotDialog.close();
      toast('Slot saved');
      loadEvents();
    } catch (err) { formError(slotForm, err.message); }
  });

  document.getElementById('event-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    const ev = state.events.find((x) => x.id === id);
    try {
      switch (btn.dataset.act) {
        case 'edit-event': return openEvent(ev);
        case 'add-slot': return openSlot(id, null);
        case 'edit-slot': {
          const parent = state.events.find((x) => x.id === Number(btn.dataset.event));
          return openSlot(parent.id, parent.slots.find((s) => s.id === id));
        }
        case 'del-event':
          if (!confirm(`Delete “${ev.title}” and all its slots?`)) return;
          await api(`/api/admin/events/${id}`, { method: 'DELETE' });
          toast('Event deleted');
          return loadEvents();
        case 'del-slot':
          if (!confirm('Delete this slot?')) return;
          await api(`/api/admin/slots/${id}`, { method: 'DELETE' });
          toast('Slot deleted');
          return loadEvents();
      }
    } catch (err) { toast(err.message); }
  });

  // ---------- bookings ----------
  const bEvent = document.getElementById('b-event');
  const bStatus = document.getElementById('b-status');
  const bSearch = document.getElementById('b-search');
  let bookings = [];
  let searchTimer;

  function bookingParams() {
    const p = new URLSearchParams();
    if (bEvent.value) p.set('event_id', bEvent.value);
    if (bStatus.value) p.set('status', bStatus.value);
    if (bSearch.value.trim()) p.set('q', bSearch.value.trim());
    return p;
  }

  async function loadBookings() {
    const p = bookingParams();
    document.getElementById('b-csv').href = '/api/admin/bookings.csv?' + p;
    try {
      bookings = await api('/api/admin/bookings?' + p);
    } catch (err) { return toast(err.message); }
    document.getElementById('b-count').textContent = `${bookings.length} booking${bookings.length === 1 ? '' : 's'}`;
    const table = document.getElementById('b-table');
    if (!bookings.length) { table.innerHTML = '<tr><td class="muted">No bookings match.</td></tr>'; return; }
    table.innerHTML = `<tr><th>Person</th><th>Event / slot</th><th>Status</th><th>Ticket</th><th>Actions</th></tr>` +
      bookings.map((b) => {
        const status = b.status === 'paid'
          ? (b.checked_in_at ? `<span class="badge in">Checked in</span><div class="muted">${fmtStamp(b.checked_in_at)}</div>` : '<span class="badge paid">Paid</span>')
          : `<span class="badge ${b.status}">${b.status === 'pending' ? 'Pending' : 'Failed'}</span>`;
        const mail = b.status !== 'paid' ? '' : b.email_sent_at ? `<div class="muted">✉ sent ${fmtStamp(b.email_sent_at)}</div>`
          : b.email_error ? `<div class="muted" style="color:var(--bad)" title="${esc(b.email_error)}">✉ failed</div>` : '<div class="muted">✉ sending…</div>';
        const actions = [];
        if (b.status === 'paid' && !b.checked_in_at) actions.push(`<button class="btn green" data-act="checkin" data-id="${b.id}">Check in</button>`);
        if (b.status === 'paid' && b.checked_in_at) actions.push(`<button class="btn ghost" data-act="undo" data-id="${b.id}">Undo</button>`);
        if (b.status === 'paid') actions.push(`<button class="btn ghost" data-act="resend" data-id="${b.id}">Resend email</button>`);
        if (b.status === 'pending') actions.push(`<button class="btn ghost" data-act="sync" data-id="${b.id}">Re-check payment</button>`);
        return `<tr>
          <td><b>${esc(b.name)}</b><div class="muted">${esc(b.email)}<br>${esc(b.phone)}</div></td>
          <td>${esc(b.event_title)}<div class="muted">${fmtDate(b.event_date)} · ${fmtRange(b.start_time, b.end_time)}</div></td>
          <td>${status}<div class="muted">${rupees(b.amount)}</div></td>
          <td><span class="mono">${esc(b.code) || '—'}</span>${mail}<div class="muted mono" style="font-size:11px">${esc(b.order_id)}</div></td>
          <td><div class="row-actions">${actions.join('')}</div></td>
        </tr>`;
      }).join('');
  }

  bEvent.addEventListener('change', loadBookings);
  bStatus.addEventListener('change', loadBookings);
  bSearch.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadBookings, 250); });

  document.getElementById('b-table').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.dataset.id;
    btn.disabled = true;
    try {
      switch (btn.dataset.act) {
        case 'checkin': await api(`/api/admin/bookings/${id}/checkin`, { method: 'POST' }); toast('Checked in ✓'); break;
        case 'undo':
          if (!confirm('Undo this check-in?')) { btn.disabled = false; return; }
          await api(`/api/admin/bookings/${id}/undo-checkin`, { method: 'POST' }); toast('Check-in undone'); break;
        case 'resend': await api(`/api/admin/bookings/${id}/resend`, { method: 'POST' }); toast('Ticket email sent'); break;
        case 'sync': {
          const r = await api(`/api/admin/bookings/${id}/sync`, { method: 'POST' });
          toast(r.status === 'paid' ? 'Payment confirmed — ticket sent' : `Status: ${r.status}`);
          break;
        }
      }
      await loadBookings();
      loadEvents();
    } catch (err) { toast(err.message); btn.disabled = false; }
  });

  // ---------- init ----------
  guard().then(async () => {
    await loadEvents();
    let tab = 'overview';
    try { tab = sessionStorage.getItem('dil_tab') || tab; } catch { /* ignore */ }
    showTab(tab);
  }).catch(() => {});
})();
