// Small signed, expiring values for cookies (HMAC-SHA256). Used for the "code sent, waiting for it"
// step of sign-in and invitations, so nothing secret needs to be stored server-side.
import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

const secret = () => process.env.SESSION_SECRET
  || createHash('sha256').update(`hb:${process.env.SUPABASE_SERVICE_ROLE_KEY || 'dev'}`).digest('hex');

export function sign(obj, ttlMs) {
  const body = Buffer.from(JSON.stringify({ ...obj, x: Date.now() + ttlMs })).toString('base64url');
  const mac = createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}

export function unsign(value) {
  if (!value || typeof value !== 'string' || !value.includes('.')) return null;
  const [body, mac] = value.split('.');
  const want = createHmac('sha256', secret()).update(body).digest('base64url');
  const a = Buffer.from(mac || ''), b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    return obj.x > Date.now() ? obj : null;
  } catch { return null; }
}
