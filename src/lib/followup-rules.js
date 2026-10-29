// Pure follow-up rules (no database) — easy to test.
const ISO = /^\d{4}-\d{2}-\d{2}$/;
export const isoDate = v => (ISO.test(String(v || '')) && !Number.isNaN(Date.parse(v)) ? String(v) : null);

/** Who may complete / reschedule: Admin and Director for any follow-up, others only for ones they own. */
export const canActOn = (user, fu, assign) => !!user && (!!assign || (!!fu && fu.owner_id === user.id));

/** Open follow-up status for display: overdue (past due), today, upcoming, done. */
export function followState(fu, today) {
  if (fu.status === 'done') return 'done';
  return fu.due_date < today ? 'overdue' : fu.due_date === today ? 'today' : 'upcoming';
}
