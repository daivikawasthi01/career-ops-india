// Which of these location strings clearly name ONLY places outside India? (A job there is not a match for this profile.)
//   stdin: ["Bangalore", "Remote - US", ...]      stdout: the ones that are clearly foreign, as a JSON array
//
// A job often lists several places ("Bangalore · London · New York", "Thane, London"). The string is split into its places and each is judged:
// Indian (a state, a union territory, "India" or a city from portals.yml location_filter), foreign, unknown, or neutral ("Remote", "Hybrid").
// The job is reported when no place is Indian and either a foreign country, US state or region is named, or every place is a known foreign city.
// So "Ann Arbor, MI, United States" goes, while "Thane, London" stays: Thane is unrecognised, and it might be Indian.
//
// An allow-list of Indian places can never be complete (Thane, Navi Mumbai, Gandhinagar ...), and deleting a real job is worse than keeping a
// stray one. So this goes the other way: a location is reported only when it names a foreign country, US state, region or well-known foreign
// city AND names nothing Indian. "India", an Indian state or union territory, or a city from portals.yml location_filter always wins.
// Anything unrecognised ("Thane", "", "Remote", "Anywhere in the World", "KA") is unknown, and unknown is kept.
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const fold = (s) => String(s || '').normalize('NFD').replace(/\p{M}/gu, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const wordsRe = (list, flags = 'i') => new RegExp('(?<![a-z0-9])(?:' + list.map((w) => esc(w).replace(/\\? /g, '[\\s-]+')).join('|') + ')(?![a-z0-9])', flags);

// ---- Indian vocabulary: always wins ----
const INDIA = ['india', 'indian', 'bharat', 'andhra pradesh', 'arunachal pradesh', 'assam', 'bihar', 'chhattisgarh', 'goa', 'gujarat', 'haryana', 'himachal pradesh',
  'jharkhand', 'karnataka', 'kerala', 'madhya pradesh', 'maharashtra', 'manipur', 'meghalaya', 'mizoram', 'nagaland', 'odisha', 'orissa', 'punjab', 'rajasthan',
  'sikkim', 'tamil nadu', 'telangana', 'tripura', 'uttar pradesh', 'uttarakhand', 'west bengal', 'delhi', 'ncr', 'jammu', 'kashmir', 'ladakh', 'chandigarh',
  'puducherry', 'pondicherry', 'andaman', 'lakshadweep', 'daman', 'diu', 'dadra', 'nagar haveli'];
const root = new URL('../../../', import.meta.url).pathname;
const portals = yaml.load(fs.readFileSync(`${root}portals.yml`, 'utf8')) || {};
const lf = portals.location_filter || {};
const indiaRe = wordsRe([...INDIA, ...(lf.allow || []), ...(lf.always_allow || [])].map((x) => fold(String(x)).toLowerCase()).filter((x) => x.length > 2));

// ---- Foreign vocabulary: every ISO country name (from the runtime's own table) plus the places countries hide behind ----
const names = new Intl.DisplayNames(['en'], { type: 'region' });
const countries = [];
for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
  const code = String.fromCharCode(a, b);
  if (code === 'IN') continue;
  let n; try { n = names.of(code); } catch { continue; }
  if (n && n !== code && n.length > 3) countries.push(fold(n).toLowerCase());
}
const ALIASES = ['usa', 'united states of america', 'america', 'england', 'scotland', 'wales', 'northern ireland', 'great britain', 'britain', 'uae', 'emirates',
  'korea', 'russia', 'czechia', 'holland', 'americas', 'emea', 'latam'];
const US_STATES = ['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois',
  'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska',
  'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island',
  'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming', 'mid-atlantic', 'midwest',
  'ontario', 'quebec', 'british columbia', 'alberta', 'manitoba', 'nova scotia', 'new south wales', 'victoria', 'queensland', 'bavaria'];
const CITIES = ['london', 'manchester', 'new york', 'san francisco', 'los angeles', 'seattle', 'austin', 'boston', 'chicago', 'denver', 'atlanta', 'dallas', 'houston',
  'san jose', 'san diego', 'palo alto', 'mountain view', 'sunnyvale', 'menlo park', 'redmond', 'bellevue', 'portland', 'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary',
  'mexico city', 'sao paulo', 'buenos aires', 'bogota', 'santiago', 'lima', 'dublin', 'paris', 'berlin', 'munich', 'hamburg', 'amsterdam', 'rotterdam', 'brussels', 'madrid',
  'barcelona', 'lisbon', 'milan', 'rome', 'zurich', 'geneva', 'vienna', 'prague', 'warsaw', 'krakow', 'budapest', 'bucharest', 'sofia', 'athens', 'stockholm', 'oslo', 'copenhagen',
  'helsinki', 'tallinn', 'riga', 'vilnius', 'kyiv', 'moscow', 'istanbul', 'dubai', 'abu dhabi', 'doha', 'riyadh', 'tel aviv', 'cairo', 'lagos', 'nairobi', 'johannesburg',
  'cape town', 'singapore', 'kuala lumpur', 'jakarta', 'manila', 'bangkok', 'ho chi minh', 'hanoi', 'hong kong', 'shanghai', 'beijing', 'shenzhen', 'taipei', 'tokyo', 'osaka',
  'seoul', 'sydney', 'melbourne', 'brisbane', 'perth', 'auckland', 'wellington', 'karachi', 'lahore', 'dhaka', 'colombo', 'kathmandu'];
const REGIONS = ['europe', 'north america', 'south america', 'latin america', 'middle east', 'africa', 'oceania', 'scandinavia', 'nordics', 'benelux'];
const countryRe = wordsRe([...countries, ...ALIASES, ...US_STATES, ...REGIONS]);   // names a whole country, state or region
const cityRe = wordsRe(CITIES);                                                     // names only a city
// A bare 2-letter US state code after a city ("Austin, TX"). Codes that are also Indian state codes (TN, OR, GA, AR, IN) are left out.
const US_CODES = new Set(['AL', 'AK', 'AZ', 'CA', 'CO', 'CT', 'DE', 'FL', 'HI', 'ID', 'IL', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV',
  'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'PA', 'RI', 'SC', 'SD', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC']);
const NEUTRAL = wordsRe(['remote', 'hybrid', 'onsite', 'on-site', 'on site', 'anywhere', 'worldwide', 'global', 'multiple', 'locations?', 'location', 'work', 'job', 'jobs', 'more', 'only', 'flexible', 'various', 'other', 'others', 'the', 'world', 'in', 'based', 'and', 'or'], 'gi');
// Capitalised abbreviations: only upper case counts ("us" is a word, "US" is a country).
const abbrRe = /(?<![A-Za-z])(?:US|U\.S\.A?\.?|UK|U\.K\.|UAE|EU|EMEA|AMER|DACH|ANZ|MENA)(?![A-Za-z])/;

const input = await new Promise((resolve) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => resolve(s)); });
const SPLIT = /[·•;|/]|\s+(?:or|and)\s+|,|\s[-–—]\s|[()]/i;
function kind(part) {
  const t = part.trim();
  if (indiaRe.test(t)) return 'india';
  if (countryRe.test(t) || abbrRe.test(t)) return 'country';
  if (cityRe.test(t) || US_CODES.has(t)) return 'city';
  if (!t.replace(NEUTRAL, ' ').replace(/[^A-Za-z]/g, '')) return 'neutral';   // nothing left but "Remote", "More...", dots, numbers
  return 'unknown';
}
const foreign = JSON.parse(input || '[]').filter((loc) => {
  const kinds = fold(loc).split(SPLIT).map((p) => p.trim()).filter(Boolean).map(kind);
  if (kinds.includes('india')) return false;
  if (kinds.includes('country')) return true;                          // "Ann Arbor, MI, United States": a country is named and nothing Indian is
  return kinds.includes('city') && !kinds.includes('unknown');         // city-only: "Thane, London" stays, because Thane is unknown
});
process.stdout.write(JSON.stringify(foreign));
