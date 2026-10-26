// Pure helper (no dependencies) so it can be used anywhere.
/** Repairs UTF-8 text that was read as latin-1 anywhere inside a string ("Supplier packing list — ç®±.xlsx"); real text is left alone. */
export function healText(s) {
  if (typeof s !== 'string' || !/[\u0080-\u00ff]/.test(s)) return s;
  return s.replace(/[\u0080-\u00ff]+/g, run => { const d = Buffer.from(run, 'latin1').toString('utf8'); return d.includes('\ufffd') ? run : d; });
}
