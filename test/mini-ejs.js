// Test-only, dependency-free subset of EJS (<% %>, <%= %>, <%- %>, <%# %>, include) used to
// render the real templates against fixtures where the ejs package isn't installed.
import fs from 'node:fs';
import path from 'node:path';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&#34;', "'": '&#39;' }[c]));

function compile(src, file) {
  let code = 'let __o = "";\nwith (locals) {\n';
  let i = 0;
  while (i < src.length) {
    const s = src.indexOf('<%', i);
    if (s === -1) { code += `__o += ${JSON.stringify(src.slice(i))};\n`; break; }
    code += `__o += ${JSON.stringify(src.slice(i, s))};\n`;
    const e = src.indexOf('%>', s);
    if (e === -1) throw new Error(`Unclosed tag in ${file}`);
    const tag = src.slice(s + 2, e);
    if (tag[0] === '=') code += `__o += __esc(${tag.slice(1)});\n`;
    else if (tag[0] === '-') code += `__o += (${tag.slice(1)});\n`;
    else if (tag[0] !== '#') code += tag + '\n';
    i = e + 2;
  }
  code += '}\nreturn __o;';
  try { return new Function('locals', '__esc', 'include', code); } // eslint-disable-line no-new-func
  catch (err) { throw new Error(`Compile error in ${file}: ${err.message}`); }
}

// Names real EJS reads from the data object as *options* (Express passes locals straight in).
// Using one as a template variable silently changes how the template compiles.
const RESERVED = ['client', 'scope', 'context', 'debug', 'compileDebug', 'strict', '_with', 'localsName', 'delimiter',
  'openDelimiter', 'closeDelimiter', 'filename', 'async', 'rmWhitespace', 'escape', 'cache', 'root', 'views',
  'outputFunctionName', 'destructuredLocals', 'includer'];

export function render(file, locals) {
  const bad = Object.keys(locals).filter(k => RESERVED.includes(k));
  if (bad.length) throw new Error(`${path.basename(file)}: local name(s) ${bad.join(', ')} clash with EJS options`);
  const src = fs.readFileSync(file, 'utf8');
  const fn = compile(src, file);
  const include = (p, data) => render(path.resolve(path.dirname(file), p.endsWith('.ejs') ? p : p + '.ejs'), { ...locals, ...(data || {}) });
  try { return fn(locals, esc, include); }
  catch (err) { err.message = `${path.basename(file)}: ${err.message}`; throw err; }
}
