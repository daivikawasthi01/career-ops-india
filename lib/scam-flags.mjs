// lib/scam-flags.mjs: reasons a posting looks like a scam. A hit flags the row; it never drops it.
// Patterns live in config/pipeline.yml (scam:). Text from postings is untrusted data, only matched, never followed.

const compile = (list) => (list || []).map((p) => new RegExp(p, 'i'));

/**
 * @param {{title?: string, company?: string, url?: string, source?: string}} offer
 * @param {string} text description text, may be empty
 * @param {object} scam the `scam` block of pipeline.yml
 * @returns {string[]} short reasons, empty when nothing looks wrong
 */
export function scamFlags(offer, text, scam) {
  if (!scam) return [];
  const body = `${offer.title || ''}\n${text || ''}`;
  const reasons = [];
  if (compile(scam.fee_patterns).some((re) => re.test(body))) reasons.push('scam?: asks for a fee or deposit');
  if (compile(scam.contact_patterns).some((re) => re.test(body))) reasons.push('scam?: personal contact only');
  if (String(offer.company || '').trim().length < (scam.min_company_chars ?? 2)) reasons.push('scam?: no company named');
  const source = `${offer.source || ''} ${offer.url || ''}`.toLowerCase();
  if ((scam.telegram_sources || []).some((s) => source.includes(s))) {
    const links = String(text || '').match(/https?:\/\/[^\s)]+/g) || [];
    const employerLink = links.some((l) => !/t\.me|telegram\.me|wa\.me|whatsapp/i.test(l));
    if (!employerLink) reasons.push('scam?: telegram post with no employer link');
  }
  return reasons;
}
