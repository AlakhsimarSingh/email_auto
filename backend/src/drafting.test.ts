import assert from 'node:assert/strict';
import test from 'node:test';
import { draftProblems, templateDraft } from './jobs.js';

test('the fallback pitch is plain-language, names the business and passes the draft checks', () => {
  const draft = templateDraft('Jayaimee Designs', 'site', ['no_booking_link', 'slow_lcp'], 'Alakhsimar Singh');
  assert.match(draft.subject, /Jayaimee Designs' website/);
  assert.match(draft.body, /costing you customers/);
  assert.match(draft.body, /I can add a clear booking or ordering button/);
  assert.doesNotMatch(draft.body, /PageSpeed|Contentful|LCP|\d/);
  assert.deepEqual(draftProblems(draft, 'Jayaimee Designs', [], []), []);
});

test('no-website pitch never claims the business has no website', () => {
  const draft = templateDraft('Rosedale Dental', 'no_site', ['no_website_listing', 'phone_no_booking'], 'Alakhsimar Singh');
  assert.match(draft.body, /couldn't find a website linked from your public listing/);
  assert.doesNotMatch(draft.body, /you (do not|don't) have a website/i);
  assert.deepEqual(draftProblems(draft, 'Rosedale Dental', [], []), []);
});

test('draft checks explain exactly what is wrong in plain English', () => {
  const problems = draftProblems({ subject: 'Hi', body: 'Your LCP is 4.2 seconds. Guaranteed results! https://evil.example' }, 'Maple Dental', [], ['results']);
  assert.ok(problems.some((problem) => /subject line/.test(problem)));
  assert.ok(problems.some((problem) => /words; it should be 70–160/.test(problem)));
  assert.ok(problems.some((problem) => /doesn't mention the business/.test(problem)));
  assert.ok(problems.some((problem) => /jargon \("LCP"\)/.test(problem)));
  assert.ok(problems.some((problem) => /number the agent didn't measure \("4.2"\)/.test(problem)));
  assert.ok(problems.some((problem) => /pushy wording/.test(problem)));
  assert.ok(problems.some((problem) => /link other than your portfolio/.test(problem)));
});

test('all-caps subject lines are flagged as spammy', () => {
  const body = 'Hi Neo Plus team, '.concat('word '.repeat(80));
  assert.ok(draftProblems({ subject: 'WEBSITE SUGGESTION - Improve bookings', body: `${body} Neo Plus` }, 'Neo Plus', [], []).some((problem) => /ALL CAPS/.test(problem)));
  assert.ok(!draftProblems({ subject: 'A quick win for Neo Plus', body: `${body} Neo Plus` }, 'Neo Plus', [], []).some((problem) => /ALL CAPS/.test(problem)));
});
