// lib/seniority.mjs: read the experience a job description asks for.
// ATS boards carry no experience field, so this looks for phrases such as
// "3+ years of experience", "minimum 2 years", "2-4 yrs experience".
// Free text is untrusted data: this only extracts numbers, nothing in it is acted on.

const FRESHER = /\b(freshers?|fresh graduates?|entry[- ]level|no (?:prior )?experience|0\s*(?:-|to)\s*\d+\s*(?:years?|yrs?)|recent graduates?)\b/i;
const EXP = '(?:years?|yrs?)(?:\\s+of)?(?:\\s+(?:relevant|professional|hands[- ]on|work|industry|prior|total|software|engineering|development))*\\s+(?:experience|exp)';
// "3+ years of experience", "2-4 years experience", "5 years' experience"
const RANGE = new RegExp(`\\b(\\d{1,2})\\s*(?:\\+|plus)?\\s*(?:(?:-|–|to)\\s*(\\d{1,2}))?\\s*\\+?\\s*${EXP.replace("(?:years?|yrs?)", "(?:years?|yrs?)(?:'s|’s)?")}`, 'gi');
// "minimum 2 years", "at least 3 years", "min. 3 yrs"
const MINIMUM = /\b(?:minimum(?:\s+of)?|at\s+least|min\.?(?:\s+of)?)\s+(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b(?!\s+(?:old|ago|of age|in business|since|of operation))/gi;

/**
 * Lowest stated minimum years of experience in `text`, or null when none is stated.
 * Takes the LOWEST lower bound across mentions, so a posting that also welcomes
 * freshers or mentions a smaller figure is not read as senior.
 */
export function minExperienceYears(text) {
  const s = String(text ?? '');
  if (FRESHER.test(s)) return 0;
  const mins = [];
  for (const m of s.matchAll(RANGE)) mins.push(Number(m[1]));
  for (const m of s.matchAll(MINIMUM)) mins.push(Number(m[1]));
  return mins.length ? Math.min(...mins) : null;
}

/**
 * @param {string} text description
 * @param {{enabled?: boolean, flag_min_years?: number|null, drop_min_years?: number|null}} guard
 * @returns {{action: 'keep'|'flag'|'drop', years: number|null}}
 */
export function seniorityVerdict(text, guard = {}) {
  const years = guard.enabled === false ? null : minExperienceYears(text);
  if (years === null) return { action: 'keep', years };
  if (Number.isFinite(guard.drop_min_years) && years >= guard.drop_min_years) return { action: 'drop', years };
  if (Number.isFinite(guard.flag_min_years) && years >= guard.flag_min_years) return { action: 'flag', years };
  return { action: 'keep', years };
}
