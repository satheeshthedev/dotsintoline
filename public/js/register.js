(() => {
  const { api, esc, fmtDate, fmtRange } = DIL;
  const root = document.getElementById('root');
  const params = new URLSearchParams(location.search);
  const eventId = params.get('event');
  let slotId = Number(params.get('slot')) || null;
    let event = null;

  function fail(title, msg) {
    root.innerHTML = `<div class="empty" style="margin-top:20px"><h3>${esc(title)}</h3><p>${esc(msg)}</p>
      <a class="btn" href="/#meetups">See all meetups</a></div>`;
  }

  async function load() {
    try {
      let events;
      events = await api('/api/events');
      event = eventId
        ? events.find((e) => String(e.id) === String(eventId))
        // No meetup chosen: use the next upcoming one that still has seats.
        : events.find((e) => e.slots.some((s) => s.seats_left > 0)) || events[0];
      if (!event) {
        return eventId
          ? fail('Meetup not available', 'This meetup is no longer open for registration.')
          : fail('Registrations open soon', 'There is no upcoming meetup right now. Follow @dots.into_line on Instagram to hear first.');
      }
    } catch (e) {
      return fail('Meetup not available', e.message);
    }
    render();
  }

  function render() {
    root.replaceChildren(document.getElementById('page').content.cloneNode(true));
    const $ = (s) => root.querySelector(s);
    document.title = `Register · ${event.title} · Dots into Line`;

    if (event.poster_url) { $('[data-poster]').hidden = false; $('[data-poster] img').src = event.poster_url; $('[data-poster] img').alt = `${event.title} poster`; }
    $('[data-title]').textContent = event.title;
    $('[data-date]').textContent = fmtDate(event.event_date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (event.venue) {
      $('[data-venue]').innerHTML = event.map_url
        ? `<a href="${esc(event.map_url)}" target="_blank" rel="noopener">${esc(event.venue)}</a>` : esc(event.venue);
    } else $('[data-venue-row]').remove();
    $('[data-desc]').textContent = event.description || '';
    if (event.what_to_bring) { $('[data-bring]').hidden = false; $('[data-bring] span').textContent = event.what_to_bring; }

    // pick the requested slot, or the first one with seats
    const open = event.slots.filter((s) => s.seats_left > 0);
    if (!open.length) return fail('Fully booked', 'All slots for this meetup are full. Follow us on Instagram for the next one!');
    if (!open.some((s) => s.id === slotId)) slotId = open[0].id;

    $('[data-slots]').innerHTML = event.slots.map((s) => {
      const full = s.seats_left <= 0;
      return `<label class="pick ${full ? 'full' : ''}">
        <input type="radio" name="slot" value="${s.id}" ${s.id === slotId ? 'checked' : ''} ${full ? 'disabled' : ''}>
        <span class="pick-body">
          <span class="time">${fmtRange(s.start_time, s.end_time)}</span>
          <span class="label">${esc(s.label)}</span>
          <span class="foot"><b></b><span>${full ? 'Full' : `${s.seats_left} left`}</span></span>
        </span>
      </label>`;
    }).join('');

    const form = $('#reg-form');
    try {
      const saved = JSON.parse(localStorage.getItem('dil_contact') || '{}');
      for (const k of ['name', 'email', 'phone']) if (saved[k]) form.elements[k].value = saved[k];
    } catch { /* storage unavailable */ }

    form.addEventListener('change', (e) => { if (e.target.name === 'slot') { slotId = Number(e.target.value); updateSummary(); } });
    form.addEventListener('submit', submit);
    updateSummary();
  }

  function updateSummary() {
    const s = event.slots.find((x) => x.id === slotId);
    const $ = (sel) => root.querySelector(sel);
    $('[data-sum-slot]').textContent = `${fmtDate(event.event_date)} · ${fmtRange(s.start_time, s.end_time)}`;
    $('[data-sum-label]').textContent = s.label || '1 spot';
    $('[data-sum-price]').textContent = 'Free';
    history.replaceState(null, '', `?event=${event.id}&slot=${s.id}`);
  }

  async function submit(e) {
    e.preventDefault();
    const form = e.target;
    const errEl = root.querySelector('#form-error');
    const payBtn = root.querySelector('#pay-btn');
    const showError = (msg) => { errEl.textContent = msg; errEl.classList.add('show'); errEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
    errEl.classList.remove('show');

    const body = {
      slotId,
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      phone: form.elements.phone.value.trim(),
    };
    if (body.name.length < 2) { form.elements.name.focus(); return showError('Please enter your name.'); }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(body.email)) { form.elements.email.focus(); return showError('Please enter a valid email address.'); }
    if (body.phone.replace(/\D/g, '').length < 10) { form.elements.phone.focus(); return showError('Please enter a valid 10-digit mobile number.'); }

    try { localStorage.setItem('dil_contact', JSON.stringify({ name: body.name, email: body.email, phone: body.phone })); } catch { /* ignore */ }

    const label = payBtn.innerHTML;
    payBtn.disabled = true;
    payBtn.textContent = 'Registering…';
    try {
      const res = await api('/api/bookings', { body });
      location.assign(`/status.html?order_id=${encodeURIComponent(res.orderId)}`);
    } catch (err) {
      showError(err.message);
      payBtn.disabled = false;
      payBtn.innerHTML = label;
      if (err.status === 409) { // seats changed — refresh availability, keep typed details
        const typed = { name: body.name, email: body.email, phone: body.phone };
        event = (await api('/api/events').catch(() => [])).find((x) => x.id === event.id) || event;
        render();
        const f = root.querySelector('#reg-form');
        for (const k in typed) f.elements[k].value = typed[k];
        root.querySelector('#form-error').textContent = err.message;
        root.querySelector('#form-error').classList.add('show');
      }
    }
  }

  load();
})();
