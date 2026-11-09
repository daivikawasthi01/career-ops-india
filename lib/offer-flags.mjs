// lib/offer-flags.mjs: mark borderline offers instead of dropping them.
// Flags go in offer.flags (JSON output, Excel) and, as "[flag]" text, at the end of the location,
// which is the one free-text column pipeline.md already carries.

/** Add a flag once. Returns the offer. */
export function addFlag(offer, flag) {
  offer.flags = offer.flags || [];
  if (!offer.flags.includes(flag)) {
    offer.flags.push(flag);
    offer.location = `${offer.location || 'India'} [${flag}]`;
  }
  return offer;
}
