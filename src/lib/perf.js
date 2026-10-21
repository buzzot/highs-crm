// Per-request timing: how long a page took and how much of it was spent waiting for Supabase (count + time).
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();
const SLOW_MS = Number(process.env.SLOW_MS || 500);

/** fetch() that counts calls and time for the request being handled (used by the Supabase clients). */
export const countingFetch = async (input, init) => {
  const st = als.getStore();
  if (!st) return fetch(input, init);
  const t0 = performance.now();
  try { return await fetch(input, init); }
  finally { st.calls++; st.ms += performance.now() - t0; }
};

/** Express middleware: logs requests slower than SLOW_MS (default 500 ms) with their database share. */
export function requestTiming() {
  return (req, res, next) => {
    if (/\.(css|js|png|jpg|svg|ico|woff2?)$/.test(req.path) || req.path === '/health') return next();
    const st = { calls: 0, ms: 0 }, t0 = performance.now();
    res.on('finish', () => {
      const total = performance.now() - t0;
      if (total >= SLOW_MS) console.log(`[slow] ${req.method} ${req.path} ${Math.round(total)} ms · ${st.calls} database calls took ${Math.round(st.ms)} ms (${st.calls ? Math.round(st.ms / st.calls) : 0} ms each) · status ${res.statusCode}`);
    });
    als.run(st, next);
  };
}
