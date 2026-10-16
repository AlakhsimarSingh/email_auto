import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { NICHE_PRESETS, humanizeCategory, nicheNoun, presetForCategory } from './niches.js';
import { parseImportBatch } from './imports.js';
import { decodeCloudflareEmail, hiddenEmails } from './jobs.js';

test('every Overture category belongs to exactly one business-type preset', () => {
  const seen = new Map<string, string>();
  for (const preset of NICHE_PRESETS) {
    for (const category of preset.overture) {
      assert.equal(seen.has(category), false, `${category} is in both ${seen.get(category)} and ${preset.id}`);
      seen.set(category, preset.id);
    }
    assert.match(preset.osm, /^[a-z_:]+=[a-z_]+$/, `${preset.id} has an invalid OSM fallback filter`);
  }
  assert.equal(presetForCategory('dental_clinic')?.id, 'dental');
  assert.equal(presetForCategory('bank_or_credit_union'), null);
});

test('niche nouns read naturally for presets, legacy niches and fine categories', () => {
  assert.equal(nicheNoun('dental'), 'dental clinic');
  assert.equal(nicheNoun('dentist'), 'dentist');
  assert.equal(humanizeCategory('plumbing_service', 'home_service'), 'plumbing service');
  assert.equal(humanizeCategory(null, 'restaurant'), 'restaurant');
});

test('import batches are validated and malformed items dropped', () => {
  const batch = parseImportBatch({
    source: 'overture', release: '2026-09-23.1', city: 'Toronto', country: 'ca',
    items: [
      { id: 'a1', name: 'Maple Plumbing', category: 'home_service', taxonomy: 'plumber', website: 'https://mapleplumbing.ca', email: 'info@mapleplumbing.ca', phone: '+1 416 555 0100', lat: 43.65, lon: -79.38 },
      { id: 'bad', name: '', lat: 43.6, lon: -79.3 },
      { id: 'b2', name: 'No Coordinates' },
    ],
  });
  assert.equal(batch.country, 'CA');
  assert.equal(batch.items.length, 1);
  assert.equal(batch.items[0]?.email, 'info@mapleplumbing.ca');
  assert.throws(() => parseImportBatch({ source: 'yelp', release: 'x', city: 'Toronto', country: 'CA', items: [] }));
  assert.throws(() => parseImportBatch({ source: 'overture', release: 'x', city: 'Toronto', country: 'CA', items: Array.from({ length: 501 }, () => ({})) }));
});

test('hidden emails are recovered from Cloudflare protection, JSON-LD and [at]/[dot] text', () => {
  // "info@example.com" XOR-encoded with key 0x42, as Cloudflare does.
  const plain = 'info@example.com';
  const hex = '42' + [...plain].map((char) => (char.charCodeAt(0) ^ 0x42).toString(16).padStart(2, '0')).join('');
  assert.equal(decodeCloudflareEmail(hex), plain);
  const $ = load(`
    <span class="__cf_email__" data-cfemail="${hex}">[email protected]</span>
    <script type="application/ld+json">{"@type":"LocalBusiness","contactPoint":{"email":"mailto:bookings@example.com"}}</script>
    <p>Write to hello [at] example [dot] com</p>`);
  assert.deepEqual(hiddenEmails($).sort(), ['bookings@example.com', 'hello@example.com', 'info@example.com']);
});
