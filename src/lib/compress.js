// Dependency-free response compression + cached gzip for static CSS/JS.
import { gzipSync } from 'node:zlib';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const TEXT = /^(text\/|application\/(json|javascript|xml)|image\/svg)/i;
const accepts = req => /\bgzip\b/i.test(req.headers['accept-encoding'] || '');

/** gzip HTML / JSON / text responses sent with res.send / res.render / res.json (≥ 1 KB). */
export function compress() {
  return (req, res, next) => {
    if (req.method === 'HEAD' || !accepts(req)) return next();
    const end = res.end;
    res.end = function (chunk, encoding, cb) {
      try {
        const type = String(res.getHeader('Content-Type') || '');
        if (chunk && !res.headersSent && !res.getHeader('Content-Encoding') && res.statusCode === 200 && TEXT.test(type)) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
          if (buf.length >= 1024) {
            const gz = gzipSync(buf, { level: 5 });
            res.setHeader('Content-Encoding', 'gzip');
            res.setHeader('Content-Length', gz.length);
            res.removeHeader('ETag'); // the strong ETag described the uncompressed body
            res.vary?.('Accept-Encoding');
            return end.call(this, gz, cb);
          }
        }
      } catch { /* fall through and send as is */ }
      return end.call(this, chunk, encoding, cb);
    };
    next();
  };
}

/** Serves .css / .js from `dir` gzipped (compressed once per file version, kept in memory); anything else falls through. */
export function staticGzip(dir, { maxAge = 600 } = {}) {
  const cache = new Map();
  return async (req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !/\.(css|js)$/.test(req.path) || !accepts(req)) return next();
    try {
      const file = path.join(dir, path.normalize(decodeURIComponent(req.path)));
      if (!file.startsWith(dir)) return next();
      const st = await stat(file);
      let hit = cache.get(file);
      if (!hit || hit.mtime !== st.mtimeMs) { hit = { mtime: st.mtimeMs, gz: gzipSync(await readFile(file), { level: 9 }), etag: `W/"${st.size}-${Math.round(st.mtimeMs)}"` }; cache.set(file, hit); }
      if (req.headers['if-none-match'] === hit.etag) return res.status(304).end();
      res.set({ 'Content-Type': file.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ETag: hit.etag, 'Cache-Control': `public, max-age=${maxAge}` });
      res.send(hit.gz);
    } catch { next(); }
  };
}
