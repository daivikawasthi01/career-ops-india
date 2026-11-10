import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCompanies } from '../tools/telegram-companies.mjs';
const post = (t) => `<div class="tgme_widget_message_text js-message_text" dir="auto">${t}</div>`;
test('extracts the employer from bold-unicode "X Hiring 2026" posts and ignores other posts', () => {
  const html = post('𝐉𝐢𝐨 𝐇𝐢𝐫𝐢𝐧𝐠 𝟐𝟎𝟐𝟔 – 𝐆𝐫𝐚𝐝𝐮𝐚𝐭𝐞 𝐄𝐧𝐠𝐢𝐧𝐞𝐞𝐫<br/>Apply') + post('𝐄𝐩𝐢𝐬𝐨𝐝𝐞 𝐒𝐢𝐱 𝐇𝐢𝐫𝐢𝐧𝐠 𝟐𝟎𝟐𝟔 – Trainee') + post('Hackathon from 28th October, 2021') + post('Cargill &amp; Co Hiring 2026 - SWE');
  assert.deepEqual(extractCompanies(html), ['Jio', 'Episode Six', 'Cargill & Co']);
});

import { companyFromPost } from '../tools/telegram-companies.mjs';
test('companyFromPost handles the field, "X Recruitment", and dash formats', () => {
  assert.equal(companyFromPost('🚨 PAYPAL — Internship 2027! 🎯 🏢 Company: PayPal 💼 Role: Software Engineer Intern 📍 Location: Bengaluru'), 'PayPal');
  assert.equal(companyFromPost('Cognizant Freshers Recruitment | Service Desk @ PAN India'), 'Cognizant');
  assert.equal(companyFromPost('Wipro Job Alert | Apply Now'), 'Wipro');
  assert.equal(companyFromPost('Take a look at Muse – your personal AI agent'), null);
  assert.equal(companyFromPost('Capgemini Recruitment 2026 – Associate Quality Engineer, Bangalore Apply Link- https://x.com'), 'Capgemini');
});

import { expandName } from '../tools/telegram-companies.mjs';
test('expandName strips noise tails, splits pairs, and drops junk', () => {
  assert.deepEqual(expandName('INFOSYS MASS'), ['INFOSYS']);
  assert.deepEqual(expandName('Amazon Work From Home Jobs | Bulk'), ['Amazon']);
  assert.deepEqual(expandName('Oracle & Konrad'), ['Oracle', 'Konrad']);
  assert.deepEqual(expandName('Procter & Gamble'), ['Procter & Gamble']);
  assert.deepEqual(expandName('OPENAI, EMERGENT, ANTHROPIC & GOOGLE ARE'), []);
  assert.deepEqual(expandName('FRESHERS MASS'), []);
});
