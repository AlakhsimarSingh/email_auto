import { env } from './env.js';
import { incrementUsage, monthUsage } from './usage-meter.js';

// Paid-API-free contact search, used only after the website crawl and open data found no email.
// Providers are optional: each runs only when its API key is set, within a monthly budget paced per day.

export type ContactSearchInput = { name: string; city: string | null; phone: string | null; website: string | null };
export type FoundContact = { email: string; sourceUrl: string; provider: 'tavily' | 'hunter' };
type Provider = 'tavily' | 'hunter';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const FREE_MAIL = /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|me|protonmail|proton|aol|msn|gmx|mail|rogers|shaw|telus|sympatico|bell)\./i;
const ASSET_SUFFIX = /\.(png|jpe?g|gif|webp|svg|css|js)$/i;

export function domainOf(url: string | null | undefined) {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9@.]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Pulls emails from a search result that clearly belong to this business:
 * - on the business's own domain, or
 * - (no website) within ~300 characters of the business name, on a page that also shows its phone or city.
 */
export function matchEmails(input: ContactSearchInput, page: { url: string; text: string }) {
  const ownDomain = domainOf(input.website);
  const pageDomain = domainOf(page.url);
  const raw = page.text.slice(0, 200_000);
  const emails = [...new Set((raw.match(EMAIL) ?? []).map((email) => email.toLowerCase().replace(/\.+$/, '')))]
    .filter((email) => !ASSET_SUFFIX.test(email) && !/^(noreply|no-reply|donotreply|example|test|privacy|abuse|postmaster)@/i.test(email));
  if (ownDomain) {
    return emails.filter((email) => {
      const emailDomain = email.split('@')[1] ?? '';
      // Free-mail addresses count only when published on the business's own site (sole traders often use them).
      return emailDomain === ownDomain || emailDomain.endsWith(`.${ownDomain}`) || (FREE_MAIL.test(emailDomain) && pageDomain === ownDomain);
    });
  }
  const text = normalize(raw);
  const name = normalize(input.name);
  if (name.length < 4 || !text.includes(name)) return [];
  const phoneDigits = (input.phone ?? '').replace(/\D/g, '').slice(-7);
  const digitsOnly = raw.replace(/\D/g, '');
  const hasPhone = phoneDigits.length === 7 && digitsOnly.includes(phoneDigits);
  const hasCity = !!input.city && text.includes(normalize(input.city));
  if (!hasPhone && !hasCity) return [];
  // Directory pages list many businesses, so the address must sit right next to this business's name.
  return emails.filter((email) => {
    const at = text.indexOf(normalize(email));
    if (at < 0) return false;
    for (let index = text.indexOf(name); index >= 0; index = text.indexOf(name, index + 1)) {
      if (Math.abs(index - at) <= 300) return true;
    }
    return false;
  });
}

function monthlyLimit(provider: Provider) {
  const raw = Number(provider === 'tavily' ? env.TAVILY_MONTHLY_LIMIT ?? 950 : env.HUNTER_MONTHLY_LIMIT ?? 45);
  return Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
}

/** Spreads the monthly budget evenly so the quota lasts the whole month. */
export function withinBudget(provider: Provider, usedToday: number, usedThisMonth: number, now = new Date()) {
  const limit = monthlyLimit(provider);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const dailyCap = Math.max(1, Math.ceil(limit / daysInMonth));
  return limit > 0 && usedThisMonth < limit && usedToday < dailyCap;
}

async function budgetAllows(provider: Provider) {
  const counter = provider === 'tavily' ? 'tavilyCalls' : 'hunterCalls';
  const days = await monthUsage();
  const today = new Date().toISOString().slice(0, 10);
  const usedToday = days.find((day) => day.day === today)?.[counter] ?? 0;
  const usedThisMonth = days.reduce((sum, day) => sum + day[counter], 0);
  return withinBudget(provider, usedToday, usedThisMonth);
}

async function tavily(query: string, domain: string | null) {
  await incrementUsage('tavily_calls');
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.TAVILY_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: 5,
      include_raw_content: 'text',
      ...(domain ? { include_domains: [domain] } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}`);
  const data = await response.json() as { results?: Array<{ url?: string; content?: string; raw_content?: string | null }> };
  return (data.results ?? []).flatMap((result) => result.url ? [{ url: result.url, text: `${result.content ?? ''}\n${result.raw_content ?? ''}` }] : []);
}

async function hunter(domain: string) {
  await incrementUsage('hunter_calls');
  const query = new URLSearchParams({ domain, type: 'generic', limit: '10', api_key: env.HUNTER_API_KEY ?? '' });
  const response = await fetch(`https://api.hunter.io/v2/domain-search?${query}`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Hunter returned HTTP ${response.status}`);
  const data = await response.json() as { data?: { emails?: Array<{ value?: string; confidence?: number; sources?: Array<{ uri?: string; still_on_page?: boolean }> }> } };
  return (data.data?.emails ?? [])
    .filter((item) => item.value && (item.confidence ?? 0) >= 70 && item.value.toLowerCase().endsWith(`@${domain}`))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .map((item) => ({
      email: item.value!.toLowerCase(),
      sourceUrl: item.sources?.find((source) => source.still_on_page && source.uri)?.uri ?? item.sources?.[0]?.uri ?? `https://${domain}`,
    }));
}

export function contactSearchConfigured() {
  return { tavily: !!env.TAVILY_API_KEY?.trim(), hunter: !!env.HUNTER_API_KEY?.trim() };
}

/**
 * Tries the configured providers in order, returning candidate addresses (best first) with the page they came from.
 * `onStep` reports progress for the Live feed. The caller still verifies MX, suppression and personal-email rules.
 */
export async function searchContact(input: ContactSearchInput, onStep: (message: string) => void): Promise<FoundContact[]> {
  const configured = contactSearchConfigured();
  const domain = domainOf(input.website);
  const found: FoundContact[] = [];
  if (configured.tavily && await budgetAllows('tavily')) {
    const query = domain
      ? `${input.name} contact email`
      : `"${input.name}" ${input.city ?? ''} email contact`.trim();
    onStep(domain ? `Searching ${domain} with Tavily for a published email` : `Searching the web with Tavily for a published email for ${input.name}`);
    try {
      for (const page of await tavily(query, domain)) {
        for (const email of matchEmails(input, page)) found.push({ email, sourceUrl: page.url, provider: 'tavily' });
      }
    } catch (error) {
      onStep(`Tavily search failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!found.length && domain && configured.hunter && await budgetAllows('hunter')) {
    onStep(`Looking up published addresses for ${domain} with Hunter.io`);
    try {
      for (const item of await hunter(domain)) found.push({ ...item, provider: 'hunter' });
    } catch (error) {
      onStep(`Hunter.io lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // Role addresses first: they are the right inbox for a business pitch.
  const role = /^(info|contact|hello|office|admin|enquir|inquir|sales|booking|bookings|reception|team|support|mail)[+._-]?@/i;
  return found
    .filter((item, index, all) => all.findIndex((other) => other.email === item.email) === index)
    .sort((a, b) => Number(!role.test(a.email)) - Number(!role.test(b.email)));
}
