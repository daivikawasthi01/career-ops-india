import { test } from 'node:test';
import assert from 'node:assert/strict';
import p, { parseTitle, parseFeed, resolveFeed } from '../../providers/offcampus-rss.mjs';

const item = (t, link, cat = 'Off Campus', extra = '') => `<item><title><![CDATA[${t}]]></title><link>${link}</link><pubDate>Mon, 09 Nov 2026 10:00:00 +0000</pubDate><category><![CDATA[${cat}]]></category>${extra}</item>`;
const feed = (...items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.join('')}</channel></rss>`;

test('parseTitle splits employer, role and city', () => {
  assert.deepEqual(parseTitle('Heizen Recruitment 2026 – Software Engineer, Full Stack &amp; React Native'), { company: 'Heizen', role: 'Software Engineer, Full Stack & React Native', location: 'India' });
  const c = parseTitle('Capgemini Recruitment 2026 – Associate Quality Engineer, Bangalore');
  assert.equal(c.company, 'Capgemini'); assert.equal(c.location, 'Bangalore'); assert.equal(c.role, 'Associate Quality Engineer');
  assert.equal(parseTitle('Eaton Off Campus Drive 2026 Hiring Associate Engineer').company, 'Eaton');
  assert.equal(parseTitle('India Job Market Today: J&K Bank opens posts'), null);
});
test('parseFeed keeps job posts, drops news/result posts and non-https links', () => {
  const jobs = parseFeed(feed(item('IntouchCX Recruitment 2026 – Junior Software Developer, Hyderabad', 'https://offcampusjobs4u.com/a/'),
    item('SSC Result 2026 Recruitment', 'https://offcampusjobs4u.com/b/'), item('X Recruitment 2026 – Dev', 'http://offcampusjobs4u.com/c/'), item('Daily digest', 'https://offcampusjobs4u.com/d/', 'Job News')));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].company, 'IntouchCX'); assert.equal(jobs[0].location, 'Hyderabad');
  assert.ok(jobs[0].postedAt > 0);
});
test('a non-RSS body throws instead of reading as empty', () => {
  assert.throws(() => parseFeed('<html>blocked</html>'), /not an RSS feed/);
});
test('feed host is allow-listed', () => {
  assert.equal(resolveFeed({ feed: 'https://freshersdunia.in/feed' }), 'https://freshersdunia.in/feed/');
  assert.equal(resolveFeed({}), 'https://offcampusjobs4u.com/feed/');
  assert.throws(() => resolveFeed({ feed: 'https://evil.example/feed' }), /not one of/);
  assert.throws(() => resolveFeed({ feed: 'http://freshersdunia.in/feed' }), /not one of/);
  assert.equal(p.detect({}), null);
});
