(() => {
  const { api, esc, fmtDate, fmtRange } = DIL;
  const eventsEl = document.getElementById('events');
  let config = {};
  let events = [];

  function slotHtml(e, s) {
    const full = s.seats_left <= 0;
    const low = !full && s.seats_left <= Math.max(3, Math.ceil(s.capacity * 0.2));
    const inner = `
      <span class="time">${fmtRange(s.start_time, s.end_time)}</span>
      <span class="label">${esc(s.label)}</span>
      <span class="foot"><span class="price">${s.capacity} seats</span>
        <span class="left ${low ? 'low' : ''}">${full ? 'Full' : `${s.seats_left} spot${s.seats_left === 1 ? '' : 's'} left`}</span></span>
      <span class="slot-cta">${full ? 'Fully booked' : 'Register <span class="arrow">→</span>'}</span>`;
    return full
      ? `<div class="slot" aria-disabled="true">${inner}</div>`
      : `<a class="slot" href="/register.html?event=${e.id}&slot=${s.id}">${inner}</a>`;
  }

  function renderEvents() {
    if (!events.length) {
      eventsEl.innerHTML = `<div class="empty"><h3>New dots coming soon…</h3>
        <p>No meetups are open for registration right now. Follow <a href="${esc(config.instagram)}" target="_blank" rel="noopener">@dots.into_line</a> to hear first.</p></div>`;
      return;
    }
    eventsEl.innerHTML = events.map((e) => {
      const d = DIL.parseDate(e.event_date);
      return `<article class="event-card ${e.poster_url ? '' : 'no-poster'}">
        ${e.poster_url ? `<div class="event-poster"><img src="${esc(e.poster_url)}" alt="${esc(e.title)} poster" loading="lazy"></div>` : ''}
        <div class="event-body">
          <div class="event-head">
            <div class="date-badge" aria-hidden="true">
              <div class="m">${d.toLocaleDateString('en-IN', { month: 'short' })}</div>
              <div class="d">${d.getDate()}</div>
              <div class="w">${d.toLocaleDateString('en-IN', { weekday: 'short' })}</div>
            </div>
            <div>
              <h3 class="event-title">${esc(e.title)}</h3>
              <div class="event-meta">
                <span>📅 ${fmtDate(e.event_date, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
                ${e.venue ? `<span>📍 ${esc(e.venue)}</span>` : ''}
              </div>
            </div>
          </div>
          ${e.description ? `<p class="event-desc">${esc(e.description)}</p>` : ''}
          <div class="slots">${e.slots.length ? e.slots.map((s) => slotHtml(e, s)).join('') : '<p class="event-desc">Slots will open soon.</p>'}</div>
        </div>
      </article>`;
    }).join('');
  }

  async function load() {
    try {
      [config, events] = await Promise.all([api('/api/config'), api('/api/events')]);
      if (config.instagram) document.getElementById('insta-link').href = config.instagram;
      renderEvents();
    } catch {
      eventsEl.innerHTML = `<div class="empty"><h3>Oops</h3><p>Couldn't load meetups. Please refresh the page.</p></div>`;
    }
  }

  load();
})();
