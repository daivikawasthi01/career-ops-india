import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBingRss } from '../tools/discover-careers.mjs';

test('parseBingRss keeps result items, drops bing.com links, unescapes text', () => {
  const xml = `<rss><channel><link>https://www.bing.com/search?q=x</link><image><link>https://www.bing.com/</link></image>
  <item><title>Paytm &amp; Careers</title><link>https://paytm.com/careers/</link><description>Join us</description></item>
  <item><title>Bing thing</title><link>https://www.bing.com/x</link><description>no</description></item>
  <item><title><![CDATA[Lever]]></title><link>https://jobs.lever.co/paytm</link><description></description></item></channel></rss>`;
  const r = parseBingRss(xml);
  assert.deepEqual(r.map((x) => x.url), ['https://paytm.com/careers/', 'https://jobs.lever.co/paytm']);
  assert.equal(r[0].title, 'Paytm & Careers');
  assert.equal(r[1].title, 'Lever');
});
test('parseBingRss on empty or junk gives []', () => { assert.deepEqual(parseBingRss(''), []); assert.deepEqual(parseBingRss('<html>captcha</html>'), []); });
