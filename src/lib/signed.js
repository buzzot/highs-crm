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

// ---- encryption (AES-256-GCM) for values that must stay secret inside a cookie ----
import { createCipheriv, createDecipheriv, randomBytes as rb } from 'node:crypto';
const key = () => createHash('sha256').update(`enc:${secret()}`).digest();

export function seal(obj, ttlMs) {
  const iv = rb(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify({ ...obj, x: Date.now() + ttlMs })), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}

export function unseal(value) {
  try {
    const [iv, tag, data] = String(value || '').split('.').map(s => Buffer.from(s, 'base64url'));
    const d = createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    const obj = JSON.parse(Buffer.concat([d.update(data), d.final()]).toString());
    return obj.x > Date.now() ? obj : null;
  } catch { return null; }
}

/** Keyed hash for storing codes/tokens (never stored in plain text). */
export const hashSecret = s => createHmac('sha256', secret()).update(String(s)).digest('hex');
