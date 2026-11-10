import test from 'node:test';
import assert from 'node:assert/strict';
import { labelMatches, review, toYaml } from '../tools/review-india-boards.mjs';

test('label must match the company name; short generic names are rejected', () => {
  assert.equal(labelMatches('Teachmint', 'https://teachmint.keka.com/careers'), true);
  assert.equal(labelMatches('Wissen Technology', 'https://wissen.zohorecruit.in/jobs/Careers'), true);
  assert.equal(labelMatches('Fynd', 'https://fynd.keka.com/careers'), true);
  assert.equal(labelMatches('Aha!', 'https://aha.zohorecruit.in/jobs/Careers'), false);
  assert.equal(labelMatches('Acme Corp', 'https://zenith.keka.com/careers'), false);
});

test('review keeps India boards, drops empty-India, low confidence and mismatches, skips tracked hosts', () => {
  const probeRows = [
    ['Teachmint', 'keka', 'https://teachmint.keka.com/careers', '32', '20', 'high', ''],
    ['Giga', 'zoho', 'https://giga.zohorecruit.com/jobs/Careers', '2', '0', 'high', ''],
    ['Skit.ai', 'keka', 'https://skit.keka.com/careers', '3', '3', 'low', ''],
    ['Acme Corp', 'keka', 'https://zenith.keka.com/careers', '4', '4', 'high', ''],
    ['Already', 'keka', 'https://already.keka.com/careers', '4', '4', 'high', ''],
  ];
  const { keep, rejected } = review({ probeRows, directoryRows: [], directoryHosts: new Map(), trackedHosts: new Set(['already.keka.com']) });
  assert.deepEqual(keep.map((b) => b.company), ['Teachmint']);
  assert.equal(rejected.length, 3);
  assert.match(toYaml(keep), /careers_url: https:\/\/teachmint\.keka\.com\/careers/);
});
