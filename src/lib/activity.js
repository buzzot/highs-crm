import { admin } from './supabase.js';

export async function log({ entityType, entityId, action, detail = null, actorId = null, clientVisible = false }) {
  const { error } = await admin.from('activity_log').insert({
    entity_type: entityType, entity_id: entityId, action, detail, actor_id: actorId, client_visible: clientVisible,
  });
  if (error) console.error('[activity]', error.message);
}
