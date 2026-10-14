// Database side of client edits: apply / reject a pending revision, and the notification emails.
import { admin } from './supabase.js';
import { deleteDocument } from './storage.js';
import { snapshot, diff } from './request-revisions.js';
import { changeSubmittedEmail, changeDecidedEmail } from './email-templates.js';
import { sendEmail } from './mailer.js';
import { log } from './activity.js';

const appUrl = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');

export async function loadRequestState(id) {
  const [{ data: request }, { data: items }] = await Promise.all([
    admin.from('requests').select('*').eq('id', id).single(),
    admin.from('request_items').select('*').eq('request_id', id).order('position'),
  ]);
  return { request, items: items || [] };
}

/** Delete the files that were uploaded with a revision (used on reject / withdraw). */
export async function dropRevisionFiles(revisionId, onlyIds = null) {
  const { data: docs } = await admin.from('documents').select('id').eq('revision_id', revisionId);
  for (const d of docs || []) if (!onlyIds || onlyIds.includes(d.id)) await deleteDocument(d.id).catch(e => console.error(`[revision] delete file ${d.id}: ${e.message}`));
}

/**
 * Approve: copy the client's version onto the request, map files, mark outdated quotes as superseded
 * and send the request back to "reviewing" so the team prepares an updated offer.
 */
export async function applyRevision(rev, actorId, note) {
  const { request, items } = await loadRequestState(rev.request_id);
  if (!request) throw new Error('Request not found.');
  const cur = snapshot(request, items);
  const data = rev.data;
  const d = diff(cur, data);

  // header
  const single = data.items.length === 1 ? data.items[0] : null;
  const { error: hErr } = await admin.from('requests').update({
    title: data.title, description: data.description, destination_country: data.destination_country, destination_city: data.destination_city,
    needed_by: data.needed_by || null, delivery_mode: data.delivery_mode || null, target_currency: data.target_currency || 'USD',
    quantity: single?.quantity ?? null, target_unit_price: single?.target_unit_price ?? null,
    status: ['new', 'quoted', 'reviewing'].includes(request.status) ? (request.status === 'new' ? 'new' : 'reviewing') : request.status,
  }).eq('id', request.id);
  if (hErr) throw hErr;

  // products: update / insert / delete
  const refToId = {};
  for (const [pos, it] of data.items.entries()) {
    const row = { name: it.name, description: it.description ?? null, quantity: it.quantity ?? null, unit: it.unit || 'pcs', target_unit_price: it.target_unit_price ?? null, position: pos };
    if (it.id && items.some(x => x.id === it.id)) {
      await admin.from('request_items').update(row).eq('id', it.id);
      refToId[it.id] = it.id;
    } else {
      const { data: ins, error } = await admin.from('request_items').insert({ ...row, request_id: request.id }).select('id').single();
      if (error) throw error;
      if (it.tmp) refToId[it.tmp] = ins.id;
    }
  }
  const removedIds = d.removed.map(r => r.id);
  if (removedIds.length) await admin.from('request_items').delete().in('id', removedIds);

  // files
  for (const nd of data.new_docs || []) {
    await admin.from('documents').update({ revision_id: null, request_item_id: nd.item ? (refToId[nd.item] || null) : null }).eq('id', nd.doc).eq('revision_id', rev.id);
  }
  for (const docId of data.remove_doc_ids || []) {
    const { data: doc } = await admin.from('documents').select('id').eq('id', docId).eq('entity_type', 'request').eq('entity_id', request.id).maybeSingle();
    if (doc) await deleteDocument(doc.id).catch(e => console.error(`[revision] remove file ${doc.id}: ${e.message}`));
  }

  // outdated offers (accepted quotes are never touched)
  let q = admin.from('quotes').update({ status: 'superseded' }).eq('request_id', request.id).in('status', ['draft', 'sent']);
  if (!d.affectsAll) {
    const stale = [...new Set(d.staleItemIds)];
    q = stale.length ? q.or(`request_item_id.is.null,request_item_id.in.(${stale.join(',')})`) : q.is('request_item_id', null);
  }
  const { error: qErr } = await q;
  if (qErr) console.error(`[revision] supersede quotes: ${qErr.message}`);

  await admin.from('request_revisions').update({ status: 'approved', decided_by: actorId, decided_at: new Date().toISOString(), admin_note: note || null, updated_at: new Date().toISOString() }).eq('id', rev.id);
  await log({ entityType: 'request', entityId: request.id, action: 'changes_approved', actorId, clientVisible: true, detail: note ? { note } : null });
  return { request, diff: d };
}

export async function rejectRevision(rev, actorId, note) {
  await dropRevisionFiles(rev.id);
  await admin.from('request_revisions').update({ status: 'rejected', decided_by: actorId, decided_at: new Date().toISOString(), admin_note: note || null, updated_at: new Date().toISOString() }).eq('id', rev.id);
  await log({ entityType: 'request', entityId: rev.request_id, action: 'changes_declined', actorId, clientVisible: true, detail: note ? { note } : null });
}

// ---------- emails ----------
async function mail(to, m) {
  if (!to?.length) return;
  try { await sendEmail({ to, ...m }); } catch (e) { console.error(`[revision] email to ${to}: ${e.message}`); }
}

export async function notifyStaffOfChange(req0, user) {
  const { data: request } = await admin.from('requests').select('id, ref, title, org_id, assigned_to').eq('id', req0.id).single();
  if (!request) return;
  let to = [];
  if (request.assigned_to) {
    const { data } = await admin.from('profiles').select('email').eq('id', request.assigned_to).eq('active', true).maybeSingle();
    if (data?.email) to = [data.email];
  }
  if (!to.length) {
    const { data } = await admin.from('profiles').select('email').eq('role', 'admin').eq('active', true);
    to = (data || []).map(x => x.email).filter(Boolean);
  }
  const { data: org } = await admin.from('organizations').select('name').eq('id', request.org_id).maybeSingle();
  await mail(to, changeSubmittedEmail({ request, orgName: org?.name, who: user.full_name || user.email, url: `${appUrl()}/admin/sourcing/${request.id}` }));
}

export async function notifyClientOfDecision(request, rev, approved, note) {
  const { data: p } = rev.created_by ? await admin.from('profiles').select('email').eq('id', rev.created_by).maybeSingle() : { data: null };
  if (p?.email) await mail([p.email], changeDecidedEmail({ request, approved, note, url: `${appUrl()}/portal/requests/${request.id}` }));
}
