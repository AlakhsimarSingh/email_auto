import assert from 'node:assert/strict';
import test from 'node:test';
import { load } from 'cheerio';
import { draftProblems, templateDraft } from './jobs.js';
import { extractBusinessInsight, insightFromSignals, insightSignals, presetIdFor, PLAYBOOK } from './business-insight.js';

const salonHtml = `
  <html><head><meta name="description" content="Family-run hair salon in Chicago offering cuts, colour and balayage since 2009."></head>
  <body><nav><a href="/">Home</a><a href="/services">Cuts & Colour</a><a href="/bridal">Bridal Styling</a><a href="/contact">Contact</a></nav>
  <h1>Glow Hair Studio</h1><p>Call us to book your appointment, we are open Tuesday to Saturday.</p>
  <a href="/price-list.pdf">Price list</a></body></html>`;

test('reads what the business does and where it works by hand, with quoted evidence', () => {
  const insight = extractBusinessInsight([{ url: 'https://glowhair.example', $: load(salonHtml) }], 'hair salon', { category: 'personal_or_beauty_service' });
  assert.match(insight.summary ?? '', /Family-run hair salon in Chicago/);
  assert.ok(insight.services.includes('Cuts & Colour') && insight.services.includes('Bridal Styling'));
  assert.ok(!insight.services.includes('Home') && !insight.services.includes('Contact'));
  const keys = insight.opportunities.map((item) => item.key);
  assert.ok(keys.includes('opp_phone_booking'), 'phone booking detected');
  assert.ok(keys.includes('opp_pdf_menu'), 'PDF price list detected');
  assert.match(insight.opportunities.find((item) => item.key === 'opp_phone_booking')!.evidence, /Call us to book your appointment/);
  assert.deepEqual(insight.playbook, PLAYBOOK.beauty);
});

test('a site that already uses an online booking tool is not pitched phone-booking automation', () => {
  const html = salonHtml.replace('</body>', '<script src="https://assets.calendly.com/widget.js"></script></body>');
  const insight = extractBusinessInsight([{ url: 'https://glowhair.example', $: load(html) }], 'hair salon', null);
  assert.ok(!insight.opportunities.some((item) => item.key === 'opp_phone_booking'));
});

test('insight survives a round trip through stored signals, and business types resolve sensibly', () => {
  const insight = extractBusinessInsight([{ url: 'https://glowhair.example', $: load(salonHtml) }], 'hair salon', null);
  const restored = insightFromSignals(insightSignals(insight), 'hair salon', null);
  assert.equal(restored?.summary, insight.summary);
  assert.deepEqual(restored?.opportunities.map((item) => item.key), insight.opportunities.map((item) => item.key));
  assert.equal(presetIdFor('plumbing service', { category: 'home_service' }), 'home_services');
  assert.equal(presetIdFor('dentist', { amenity: 'dentist' }), 'dental');
  assert.equal(presetIdFor('Italian restaurant', null), 'restaurants');
});

test('the ready-made pitch leads with automation and mentions website issues briefly', () => {
  const insight = extractBusinessInsight([{ url: 'https://glowhair.example', $: load(salonHtml) }], 'hair salon', { category: 'personal_or_beauty_service' });
  const draft = templateDraft('Glow Hair Studio', 'site', ['no_https', 'slow_lcp'], 'Alakhsimar Singh', 'Chicago', insight);
  assert.match(draft.body, /I noticed your site asks people to call to book/);
  assert.match(draft.body, /That's exactly the kind of work I automate/);
  assert.match(draft.body, /online booking that drops appointments straight into your calendar/);
  assert.match(draft.body, /also spotted that browsers flag it as "Not secure" and it loads slowly on phones/);
  assert.ok(draft.body.indexOf('automate') < draft.body.indexOf('Not secure'), 'automation comes before website issues');
  assert.doesNotMatch(draft.body, /PageSpeed|Contentful|LCP|\d/);
  assert.deepEqual(draftProblems(draft, 'Glow Hair Studio', [], []), []);
});

test('without manual-work signs the pitch uses ideas for that type of business, and no-website leads stay honest', () => {
  const plain = templateDraft('Rosedale Dental', 'site', ['missing_meta'], 'Alakhsimar Singh', 'Toronto', { summary: null, services: [], opportunities: [], playbook: PLAYBOOK.dental! });
  assert.match(plain.body, /for example online appointment requests and automatic appointment and recall reminders/);
  assert.deepEqual(draftProblems(plain, 'Rosedale Dental', [], []), []);
  const noSite = templateDraft('Rosedale Dental', 'no_site', ['no_website_listing'], 'Alakhsimar Singh', 'Toronto', { summary: null, services: [], opportunities: [], playbook: PLAYBOOK.dental! });
  assert.match(noSite.body, /couldn't find a website linked from your public listing/);
  assert.doesNotMatch(noSite.body, /you (do not|don't) have a website/i);
  assert.deepEqual(draftProblems(noSite, 'Rosedale Dental', [], []), []);
});

test('draft checks explain exactly what is wrong in plain English', () => {
  const problems = draftProblems({ subject: 'Hi', body: 'Your LCP is 4.2 seconds and our CRM helps. Guaranteed results! https://evil.example' }, 'Maple Dental', [], ['results']);
  assert.ok(problems.some((problem) => /subject line/.test(problem)));
  assert.ok(problems.some((problem) => /words; it should be 70–220/.test(problem)));
  assert.ok(problems.some((problem) => /doesn't mention the business/.test(problem)));
  assert.ok(problems.some((problem) => /jargon/.test(problem)));
  assert.ok(problems.some((problem) => /number the agent didn't measure \("4.2"\)/.test(problem)));
  assert.ok(problems.some((problem) => /pushy wording/.test(problem)));
  assert.ok(problems.some((problem) => /link other than your portfolio/.test(problem)));
});

test('all-caps subject lines are flagged as spammy', () => {
  const body = 'Hi Neo Plus team, '.concat('word '.repeat(80));
  assert.ok(draftProblems({ subject: 'WEBSITE SUGGESTION - Improve bookings', body: `${body} Neo Plus` }, 'Neo Plus', [], []).some((problem) => /ALL CAPS/.test(problem)));
  assert.ok(!draftProblems({ subject: 'A quick win for Neo Plus', body: `${body} Neo Plus` }, 'Neo Plus', [], []).some((problem) => /ALL CAPS/.test(problem)));
});

test('the owner bio adds credibility, and only its own numbers are allowed', async () => {
  const { parseSenderProfile } = await import('./sender-profile.js');
  const bio = "I'm Alakhsimar, a full-stack developer. I rebuilt the booking platform for Maan Travels, taking its speed score from 19 to 99.";
  const draft = templateDraft('Glow Hair Studio', 'site', ['no_https'], 'Alakhsimar Singh', 'Chicago', { summary: null, services: [], opportunities: [], playbook: PLAYBOOK.beauty! }, bio);
  assert.ok(draft.body.includes(bio), 'bio appears in the pitch');
  assert.deepEqual(draftProblems(draft, 'Glow Hair Studio', [], [], bio), [], 'numbers copied from the bio pass');
  const invented = { subject: draft.subject, body: draft.body.replace('19 to 99', '19 to 100') };
  assert.ok(draftProblems(invented, 'Glow Hair Studio', [], [], bio).some((problem) => /number the agent didn't measure \("100"\)/.test(problem)), 'a number not in the bio is still flagged');
  assert.equal(parseSenderProfile({ bio: '' }).bio, null);
  assert.throws(() => parseSenderProfile({ bio: 'Too short' }));
  assert.throws(() => parseSenderProfile({ bio: 'See my work at https://example.com for details about me.' }));
});
