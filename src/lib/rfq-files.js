// Files attached to an RFQ: which can be read by AI, how a review is stored and summarised. Pure functions (no database).
export const MAX_FILES = 12;
export const CHECKABLE = (mime = '', name = '') => /^image\/(png|jpe?g|gif|webp)$/i.test(mime) || /pdf/i.test(mime) || /\.pdf$/i.test(name);
export const isImage = (mime = '') => /^image\/(png|jpe?g|gif|webp)$/i.test(mime);

const KIND = { company_name: 'Company name', person_name: 'Person', email: 'Email', phone: 'Phone', address: 'Address', logo: 'Logo', website: 'Website', bank_details: 'Bank details', price: 'Client price', other: 'Client detail' };
const s = (v, n) => String(v ?? '').trim().slice(0, n);

/** One file's AI answer → the review we store and show. */
export function toReview(ai) {
  const issues = [];
  const language = s(ai?.language, 40) || '';
  if (ai?.non_english === true) issues.push(`Not in English${language ? ': ' + language : ''}`);
  for (const c of Array.isArray(ai?.client_info) ? ai.client_info.slice(0, 8) : []) {
    const text = s(c?.text, 120);
    if (text) issues.push(`${KIND[c?.kind] || KIND.other}: ${text}`);
  }
  return { status: issues.length ? 'warn' : 'ok', language, issues, note: s(ai?.note, 300) };
}

export const unchecked = note => ({ status: 'unchecked', language: '', issues: [], note: note || 'Not checked by AI — open the file and look yourself.' });

/** Review data coming back from the browser: keep only the known shape. */
export function cleanReview(r) {
  const status = ['ok', 'warn', 'unchecked'].includes(r?.status) ? r.status : 'unchecked';
  return { status, language: s(r?.language, 40), issues: (Array.isArray(r?.issues) ? r.issues : []).slice(0, 12).map(x => s(x, 160)).filter(Boolean), note: s(r?.note, 300) };
}

/** For the Send button: how many attached files carry a warning / were never checked. */
export function reviewTotals(fileIds = [], review = {}) {
  let warn = 0, notChecked = 0;
  for (const id of fileIds) { const r = review[id]; if (!r || r.status === 'unchecked') notChecked++; else if (r.status === 'warn') warn++; }
  return { warn, notChecked };
}

export function sendWarning({ warn, notChecked }) {
  const parts = [];
  if (warn) parts.push(`${warn} attached file${warn > 1 ? 's have' : ' has'} warnings (client details or text that is not English)`);
  if (notChecked) parts.push(`${notChecked} attached file${notChecked > 1 ? 's were' : ' was'} not checked by AI`);
  return parts.length ? parts.join(' and ') + '. Send anyway?' : '';
}
