import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyFromHeadline, parseFeed } from '../tools/funding-companies.mjs';

test('companyFromHeadline pulls the company from funding headlines only', () => {
  assert.equal(companyFromHeadline('Zepto Raises $350 Mn In Fresh Funding'), 'Zepto');
  assert.equal(companyFromHeadline('Fintech Startup Kiwi Bags ₹100 Cr In Series B'), null, 'a generic lead-in is not a company');
  assert.equal(companyFromHeadline('Spry Therapeutics secures Rs 12 crore in seed round'), 'Spry Therapeutics');
  assert.equal(companyFromHeadline('Exclusive: Acme Labs raises $5 Mn'), 'Acme Labs');
  assert.equal(companyFromHeadline('Why Indian startups raise less this year'), null);
  assert.equal(companyFromHeadline('Swiggy launches new feature'), null);
});
test('parseFeed honours the date window and rejects non-RSS', () => {
  const item = (t, d) => `<item><title><![CDATA[${t}]]></title><pubDate>${d}</pubDate></item>`;
  const xml = `<rss><channel>${item('Alpha Raises $2 Mn', 'Mon, 09 Nov 2026 10:00:00 +0000')}${item('Beta Raises $2 Mn', 'Mon, 01 Jan 2024 10:00:00 +0000')}</channel></rss>`;
  assert.deepEqual(parseFeed(xml, Date.parse('2026-10-01')), ['Alpha']);
  assert.throws(() => parseFeed('<html></html>'), /not an RSS feed/);
});
