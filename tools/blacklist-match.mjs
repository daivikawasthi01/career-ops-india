// Which of these postings does data/blacklist.md rule out?
//   stdin: [{"company": "Acme", "url": "https://..."}, ...]      stdout: the positions of the blocked ones, as a JSON array
// One matcher for every writer: it is scan.mjs's own parseBlacklist / findBlacklistEntry, so the extension and the Python gate
// give the same verdict as the Node scanners (case- and punctuation-insensitive company names, optional domain scope).
import { loadBlacklist, findBlacklistEntry } from '../scan.mjs';

const input = await new Promise((resolve) => { let s = ''; process.stdin.on('data', (d) => (s += d)); process.stdin.on('end', () => resolve(s)); });
const list = loadBlacklist();
const rows = JSON.parse(input || '[]');
const blocked = [];
if (list.size) rows.forEach((r, i) => { if (findBlacklistEntry(list, r.company || '', r.url || '')) blocked.push(i); });
process.stdout.write(JSON.stringify(blocked));
process.exit(0);
