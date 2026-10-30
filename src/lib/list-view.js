// Active / Closed / All views for the list pages. "Active" is the default: finished things (cancelled, declined, delivered…)
// stay out of the way but are never lost — they are under "Closed" and "All". A single status can still be chosen from a menu.
// The query value for Active stays "open" so older links keep working ("active" is accepted too).
export function listView(raw, { active, closed }) {
  const statuses = [...active, ...closed];
  const view = raw === 'all' || raw === 'closed' ? raw : statuses.includes(raw) ? raw : 'open';
  const set = view === 'open' ? active : view === 'closed' ? closed : view === 'all' ? null : [view];
  return { view, set, statuses };
}
export function viewCounts(byStatus, { active, closed }) {
  const n = list => list.reduce((t, s) => t + (byStatus[s] || 0), 0);
  return { open: n(active), closed: n(closed), all: n(active) + n(closed) };
}
