/**
 * تحويل الأرقام العربية/الهندية إلى الأرقام الإنجليزية (0-9)
 * Converts Arabic-Indic (٠١٢٣٤٥٦٧٨٩) and Eastern Arabic (۰۱۲۳۴۵۶۷۸۹) to Western digits
 */
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EASTERN_ARABIC = '۰۱۲۳۴۵۶۷۸۹';
const WESTERN = '0123456789';

export function toWesternDigits(str) {
  if (str == null || typeof str !== 'string') return str;
  let result = '';
  for (const char of str) {
    const arabicIdx = ARABIC_INDIC.indexOf(char);
    const easternIdx = EASTERN_ARABIC.indexOf(char);
    if (arabicIdx >= 0) result += WESTERN[arabicIdx];
    else if (easternIdx >= 0) result += WESTERN[easternIdx];
    else result += char;
  }
  return result;
}
