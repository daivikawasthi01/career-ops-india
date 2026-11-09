import { chromium } from 'playwright';
import { join } from 'node:path';
import { searchResults, setSessionContext } from './discover-careers.mjs';
const run = async (label, ctx) => {
  setSessionContext(ctx);
  const r = await searchResults(ctx, '"Paytm" careers').catch((e) => { console.log(label, 'ERR', e.message); return []; });
  console.log(label, '->', r.length, 'results', r.engine || '', r[0] ? r[0].url.slice(0, 60) : '');
};
const b = await chromium.launch({ headless: true });
await run('fresh context     ', await b.newContext({ locale: 'en-IN' }));
await b.close();
const prof = join('/Users/daivikawasthi/TechnicalProjects/JobApply/career-ops', 'data', 'cache', process.argv[2] || 'careers-profile');
const pc = await chromium.launchPersistentContext(prof, { headless: true });
await run('pipeline profile  ', pc);
await pc.close();
