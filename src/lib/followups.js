// Client follow-up tasks (table client_followups, migration 0038): real owner, due date and completion status.
import { admin } from './supabase.js';

export { isoDate, canActOn, followState } from './followup-rules.js';

/** Open + recently done follow-ups of one client. { ready:false } when migration 0038 has not been run. */
export async function clientFollowups(orgId) {
  const { data, error } = await admin.from('client_followups').select('*').eq('org_id', orgId).order('due_date').limit(200);
  return error ? { ready: false, rows: [] } : { ready: true, rows: data || [] };
}

/** Rows for the Dashboard: open follow-ups due today or earlier. Never throws (table missing → none). */
export async function dueFollowups(today) {
  try {
    const { data, error } = await admin.from('client_followups').select('id, org_id, title, due_date, owner_id, organizations(name)').eq('status', 'open').lte('due_date', today).order('due_date').limit(300);
    return error ? [] : data || [];
  } catch { return []; }
}

