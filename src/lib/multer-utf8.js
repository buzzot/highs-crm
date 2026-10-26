// multer reads uploaded file names as latin-1, so "纸箱.xlsx" arrives as "ç®±.xlsx". This wrapper has the same API as
// multer but repairs every uploaded file name to the UTF-8 the browser actually sent.
import multer from 'multer';
import { healText } from './heal-text.js';
export { healText };

export function fixName(s) {
  if (typeof s !== 'string' || !s || /[^\x00-\xff]/.test(s)) return s;   // plain ASCII or already real Unicode: leave it
  return healText(s);
}

function wrap(mw) {
  return (req, res, next) => mw(req, res, err => {
    if (!err) {
      const all = [];
      if (req.file) all.push(req.file);
      if (Array.isArray(req.files)) all.push(...req.files);
      else if (req.files) Object.values(req.files).forEach(a => all.push(...a));
      all.forEach(f => { f.originalname = fixName(f.originalname); });
    }
    next(err);
  });
}

function utf8Multer(opts) {
  const inst = multer(opts);
  return {
    single: (...a) => wrap(inst.single(...a)), array: (...a) => wrap(inst.array(...a)), any: (...a) => wrap(inst.any(...a)),
    fields: (...a) => wrap(inst.fields(...a)), none: (...a) => inst.none(...a),
  };
}
utf8Multer.memoryStorage = multer.memoryStorage;
utf8Multer.diskStorage = multer.diskStorage;
export default utf8Multer;
