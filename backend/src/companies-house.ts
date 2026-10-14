const API_ORIGIN = 'https://api.company-information.service.gov.uk';

export type CompaniesHouseMatch = {
  companyNumber: string;
  companyStatus: string | null;
  companyType: string | null;
  dateOfCreation: string | null;
  sicCodes: string[];
  sourceUrl: string;
};

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedCompanyName(value: string) {
  return value.toLowerCase()
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[\s,.]+(?:limited|ltd|plc|llp)\.?$/u, '')
    .replace(/[^a-z0-9]/g, '');
}

async function requestJson(url: string, apiKey: string, fetcher: typeof fetch) {
  const response = await fetcher(url, {
    headers: {
      authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Companies House request failed with HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!isObject(payload)) throw new Error('Companies House returned an invalid response');
  return payload;
}

export async function lookupCompaniesHouse(
  businessName: string,
  apiKey: string,
  fetcher: typeof fetch = fetch,
): Promise<CompaniesHouseMatch | null> {
  const query = businessName.trim();
  if (!query || !apiKey.trim()) return null;
  const search = await requestJson(
    `${API_ORIGIN}/search/companies?q=${encodeURIComponent(query)}&items_per_page=20`,
    apiKey,
    fetcher,
  );
  if (!Array.isArray(search.items) || !Number.isSafeInteger(search.total_results) || typeof search.total_results !== 'number') {
    throw new Error('Companies House search response has an invalid result count');
  }
  if (search.total_results > search.items.length) return null;
  const expectedName = normalizedCompanyName(query);
  const matches = search.items.filter((item): item is JsonObject & { title: string; company_number: string } =>
    isObject(item) &&
    typeof item.title === 'string' &&
    typeof item.company_number === 'string' &&
    normalizedCompanyName(item.title) === expectedName,
  );
  const match = matches[0];
  if (matches.length !== 1 || !match) return null;
  const companyNumber = match.company_number;
  const details = await requestJson(`${API_ORIGIN}/company/${encodeURIComponent(companyNumber)}`, apiKey, fetcher);
  const sicCodes = Array.isArray(details.sic_codes)
    ? details.sic_codes.filter((value): value is string => typeof value === 'string' && /^\d{5}$/.test(value))
    : [];
  return {
    companyNumber,
    companyStatus: typeof match.company_status === 'string' ? match.company_status : null,
    companyType: typeof details.type === 'string' ? details.type : null,
    dateOfCreation: typeof details.date_of_creation === 'string' ? details.date_of_creation : null,
    sicCodes,
    sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${encodeURIComponent(companyNumber)}`,
  };
}
