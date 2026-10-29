import { admin } from './supabase.js';

export async function log({ entityType, entityId, action, detail = null, actorId = null, clientVisible = false }) {
  const { data, error } = await admin.from('activity_log').insert({
    entity_type: entityType, entity_id: entityId, action, detail, actor_id: actorId, client_visible: clientVisible,
  }).select('id').single();
  if (error) console.error('[activity]', error.message);
  return data?.id ?? null;   // the new entry's id (a follow-up task points back at it)
}
