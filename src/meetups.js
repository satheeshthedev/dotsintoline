// Hard-coded meetups.
// - Shown on the site even when no database is connected.
// - Copied into the database automatically the first time it's connected (when it has no events yet).
// Edit here to change what the site shows. Dates are YYYY-MM-DD, times are 24-hour HH:MM.
module.exports = [
  {
    id: 1,
    title: 'Art Workshop',
    description: 'An evening art workshop: learn, create and meet fellow artists. No experience needed. No rules, no pressure, just art.',
    venue: 'Rock Beach, Puducherry',
    map_url: 'https://maps.google.com/?q=Rock+Beach+Puducherry',
    event_date: '2026-12-02', // Wednesday
    poster_url: '',
    what_to_bring: '',
    published: 1,
    slots: [
      { id: 1, label: 'Workshop', start_time: '19:00', end_time: '22:00', capacity: 30, price: 149 },
    ],
  },
];
