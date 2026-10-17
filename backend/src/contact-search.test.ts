import assert from 'node:assert/strict';
import test from 'node:test';
import { matchEmails, withinBudget } from './contact-search.js';

const site = { name: 'Maple Plumbing', city: 'Toronto', phone: '+1 416 555 0199', website: 'https://www.mapleplumbing.ca/' };
const noSite = { name: 'Rosedale Dental Centre', city: 'Toronto', phone: '(416) 555-0123', website: null };

test('website businesses: only addresses on their own domain, or free-mail on their own pages', () => {
  const ownPage = { url: 'https://mapleplumbing.ca/contact', text: 'Email info@mapleplumbing.ca or bob@gmail.com. Site by hello@webagency.com' };
  assert.deepEqual(matchEmails(site, ownPage).sort(), ['bob@gmail.com', 'info@mapleplumbing.ca']);
  const otherPage = { url: 'https://directory.example/maple', text: 'Maple Plumbing: bob@gmail.com, info@mapleplumbing.ca' };
  assert.deepEqual(matchEmails(site, otherPage), ['info@mapleplumbing.ca']);
});

test('no-website businesses: name nearby plus phone or city, never a neighbouring listing', () => {
  const listing = { url: 'https://dir.example/toronto-dentists', text: 'Rosedale Dental Centre, 123 Yonge St, Toronto. Call 416-555-0123 or email rosedaledental@gmail.com.' };
  assert.deepEqual(matchEmails(noSite, listing), ['rosedaledental@gmail.com']);
  const crowded = { url: 'https://dir.example/list', text: `Rosedale Dental Centre in Toronto. ${'Other clinic details. '.repeat(40)} Contact other@clinic.ca` };
  assert.deepEqual(matchEmails(noSite, crowded), []);
  const wrongCity = { url: 'https://dir.example/x', text: 'Rosedale Dental Centre, Vancouver: rd@gmail.com' };
  assert.deepEqual(matchEmails(noSite, wrongCity), []);
});

test('ignores image file names and no-reply addresses', () => {
  const page = { url: 'https://mapleplumbing.ca', text: 'logo@2x.png noreply@mapleplumbing.ca info@mapleplumbing.ca' };
  assert.deepEqual(matchEmails(site, page), ['info@mapleplumbing.ca']);
});

test('monthly budgets are paced per day and stop at the monthly limit', () => {
  const october = new Date('2026-10-16T12:00:00Z'); // 31 days: 950 / 31 -> 31 per day
  assert.equal(withinBudget('tavily', 30, 400, october), true);
  assert.equal(withinBudget('tavily', 31, 400, october), false);
  assert.equal(withinBudget('tavily', 0, 950, october), false);
  assert.equal(withinBudget('hunter', 1, 10, october), true); // 45 / 31 -> 2 per day
  assert.equal(withinBudget('hunter', 2, 10, october), false);
});
