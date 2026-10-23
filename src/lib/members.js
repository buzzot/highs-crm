// Invitation status helpers — no database access, so they are easy to test.
export const INVITE_DAYS = 14;

/**
 * One row per person for the Users / Staff lists, with invitation status:
 *   accepted · pending (with days left) · expired · no invite (created by hand)
 */
export function memberRows(profiles = [], invitations = [], now = new Date()) {
  const latest = {};
  for (const inv of [...invitations].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))) {
    const k = inv.email.toLowerCase();
    if (!latest[k] && !inv.revoked_at) latest[k] = inv;
  }
  const status = (p, inv) => {
    if (p?.accepted_at || inv?.accepted_at) return { state: 'accepted', accepted_at: p?.accepted_at || inv.accepted_at };
    if (!inv) return { state: p ? 'manual' : 'none' };
    const exp = inv.expires_at ? new Date(inv.expires_at) : new Date(new Date(inv.created_at).getTime() + INVITE_DAYS * 864e5);
    const daysLeft = Math.ceil((exp - now) / 864e5);
    return { state: daysLeft > 0 ? 'pending' : 'expired', sent_at: inv.created_at, expires_at: exp.toISOString(), days_left: daysLeft };
  };
  const rows = profiles.map(p => ({ ...p, ...status(p, latest[p.email.toLowerCase()]) }));
  const known = new Set(profiles.map(p => p.email.toLowerCase()));
  for (const [email, inv] of Object.entries(latest)) {
    if (!known.has(email) && !inv.accepted_at) rows.push({ id: null, email, full_name: null, active: true, role: inv.role, ...status(null, inv) });
  }
  const order = { pending: 0, expired: 1, accepted: 2, manual: 3 };
  return rows.sort((a, b) => (order[a.state] ?? 9) - (order[b.state] ?? 9) || a.email.localeCompare(b.email));
}

/** True when the invite form asked for "no email, just give me the link". */
export const wantsLinkOnly = body => /^(1|on|true|yes)$/i.test(String(body?.no_email || ''));
