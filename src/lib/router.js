import express from 'express';

/**
 * express.Router() whose async handlers forward rejected promises to next(err).
 * Express 4 does not do this by itself, so an unhandled DB error would hang the request.
 */
const wrap = fn => {
  if (typeof fn !== 'function' || fn.length >= 4 || fn.stack) return fn; // error handlers & sub-routers untouched
  return (req, res, next) => {
    try { const p = fn(req, res, next); if (p && typeof p.catch === 'function') p.catch(next); } catch (e) { next(e); }
  };
};

export function Router(opts) {
  const r = express.Router(opts);
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all', 'use']) {
    const orig = r[m].bind(r);
    r[m] = (...args) => orig(...args.map(a => (Array.isArray(a) ? a.map(wrap) : wrap(a))));
  }
  return r;
}
