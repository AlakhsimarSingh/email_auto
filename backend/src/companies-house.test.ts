import assert from 'node:assert/strict';
import test from 'node:test';
import { lookupCompaniesHouse } from './companies-house.js';

test('looks up a uniquely matched company and returns only company-level details', async () => {
  const requests: string[] = [];
  const responses = [
    {
      total_results: 2,
      items: [
        { title: 'Example Cafe Limited', company_number: '01234567', company_status: 'active' },
        { title: 'Example Catering Limited', company_number: '07654321', company_status: 'active' },
      ],
    },
    { type: 'ltd', date_of_creation: '2019-03-01', sic_codes: ['56102', 'invalid'] },
  ];
  const fetcher: typeof fetch = async (input) => {
    requests.push(String(input));
    const payload = responses.shift();
    assert.ok(payload);
    return new Response(JSON.stringify(payload), { status: 200 });
  };

  const match = await lookupCompaniesHouse('Example Cafe', 'test-key', fetcher);

  assert.deepEqual(match, {
    companyNumber: '01234567',
    companyStatus: 'active',
    companyType: 'ltd',
    dateOfCreation: '2019-03-01',
    sicCodes: ['56102'],
    sourceUrl: 'https://find-and-update.company-information.service.gov.uk/company/01234567',
  });
  assert.equal(requests.length, 2);
  assert.match(requests[0], /search\/companies\?q=Example%20Cafe/);
  assert.match(requests[1], /company\/01234567$/);
});

test('does not enrich a business when a name search is ambiguous', async () => {
  let detailRequested = false;
  const fetcher: typeof fetch = async () => new Response(JSON.stringify({
    total_results: 2,
    items: [
      { title: 'Example Cafe Limited', company_number: '01234567' },
      { title: 'EXAMPLE CAFE LTD', company_number: '07654321' },
    ],
  }), { status: 200 });

  const match = await lookupCompaniesHouse('Example Cafe', 'test-key', async (input, init) => {
    if (String(input).includes('/company/')) detailRequested = true;
    return fetcher(input, init);
  });

  assert.equal(match, null);
  assert.equal(detailRequested, false);
});

test('surfaces Companies House HTTP failures without exposing credentials', async () => {
  const fetcher: typeof fetch = async () => new Response('', { status: 429 });
  await assert.rejects(
    lookupCompaniesHouse('Example Cafe', 'secret-key', fetcher),
    /HTTP 429/,
  );
});
