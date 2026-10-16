import tzLookup from 'tz-lookup';
import { Prisma } from '@prisma/client';
import { prisma } from './db.js';
import { activity } from './activity.js';
import { addContactIfAllowed, isDirectoryUrl, isSocialUrl, normalizeWebsite } from './jobs.js';
import { humanizeCategory, nichePreset, presetForCategory } from './niches.js';

// Businesses pushed by the weekly open-data importer (tools/importer, run in GitHub Actions).

export type ImportItem = {
  id: string;
  name: string;
  category: string | null;
  taxonomy: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  lat: number;
  lon: number;
};

export type ImportBatch = { source: 'overture'; release: string; city: string; country: string; items: ImportItem[] };

const MAX_ITEMS = 500;
const str = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;

export function parseImportBatch(value: unknown): ImportBatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Body must be an object');
  const body = value as Record<string, unknown>;
  if (body.source !== 'overture') throw new Error('Unsupported source');
  const release = str(body.release, 40);
  const city = str(body.city, 80);
  const country = str(body.country, 2)?.toUpperCase() ?? null;
  if (!release || !city || !country || !/^[A-Z]{2}$/.test(country)) throw new Error('release, city and a 2-letter country are required');
  if (!Array.isArray(body.items) || body.items.length > MAX_ITEMS) throw new Error(`items must be an array of at most ${MAX_ITEMS}`);
  const items = body.items.flatMap((raw): ImportItem[] => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const id = str(item.id, 80);
    const name = str(item.name, 200);
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    return [{
      id, name, lat, lon,
      category: str(item.category, 80),
      taxonomy: str(item.taxonomy, 80),
      website: str(item.website, 2048),
      email: str(item.email, 254),
      phone: str(item.phone, 40),
    }];
  });
  return { source: 'overture', release, city, country, items };
}

function domainOf(url: string) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** Active campaign targets the importer should query. */
export async function importTargets() {
  const [campaigns, markets] = await Promise.all([
    prisma.campaign.findMany({ where: { active: true }, select: { niche: true, city: true, country: true } }),
    prisma.market.findMany({ where: { enabled: true }, select: { code: true } }),
  ]);
  const enabled = new Set(markets.map((market) => market.code));
  const cities = new Map<string, { city: string; country: string }>();
  const categories = new Set<string>();
  for (const campaign of campaigns) {
    const preset = nichePreset(campaign.niche);
    if (!preset || !campaign.city || !campaign.country || !enabled.has(campaign.country)) continue;
    cities.set(`${campaign.country}:${campaign.city.toLowerCase()}`, { city: campaign.city, country: campaign.country });
    preset.overture.forEach((category) => categories.add(category));
  }
  return { cities: [...cities.values()], categories: [...categories] };
}

export async function importBusinesses(batch: ImportBatch) {
  const market = await prisma.market.findUnique({ where: { code: batch.country }, select: { enabled: true } });
  if (!market?.enabled) return { received: batch.items.length, inserted: 0, withEmail: 0, skipped: { market: batch.items.length } };
  const activeNiches = new Set((await prisma.campaign.findMany({
    where: { active: true, city: { equals: batch.city, mode: 'insensitive' }, country: batch.country },
    select: { niche: true },
  })).map((campaign) => campaign.niche));

  const skipped = { duplicate: 0, ineligible: 0, untargeted: 0 };
  const candidates: Array<{ item: ImportItem; website: string | null; socialOnly: boolean; track: 'site' | 'no_site'; noun: string }> = [];
  for (const item of batch.items) {
    const preset = presetForCategory(item.category);
    if (!preset || !activeNiches.has(preset.id)) { skipped.untargeted++; continue; }
    let website: string | null = null;
    if (item.website && !isDirectoryUrl(item.website)) {
      try { website = normalizeWebsite(item.website); } catch { website = null; }
    }
    const socialOnly = Boolean(website && isSocialUrl(website));
    const track = website && !socialOnly ? 'site' : 'no_site';
    // A no-website lead needs some way to reach it.
    if (track === 'no_site' && !item.email && !item.phone) { skipped.ineligible++; continue; }
    candidates.push({ item, website: track === 'site' ? website : null, socialOnly, track, noun: humanizeCategory(item.taxonomy, item.category) });
  }

  // De-duplicate against existing businesses: same source id, same website domain, or same name in the city.
  const sourceIds = candidates.map((candidate) => `overture/${candidate.item.id}`);
  const domains = [...new Set(candidates.flatMap((candidate) => candidate.website ? [domainOf(candidate.website)] : []).filter((domain): domain is string => Boolean(domain)))];
  const [existingIds, existingSites, existingNames] = await Promise.all([
    prisma.business.findMany({ where: { osmId: { in: sourceIds } }, select: { osmId: true } }),
    domains.length
      ? prisma.$queryRaw<Array<{ domain: string }>>`
          SELECT DISTINCT lower(regexp_replace(substring(website_url from '^[a-z]+://([^/:?#]+)'), '^www\\.', '')) AS domain
          FROM businesses WHERE website_url IS NOT NULL
            AND lower(regexp_replace(substring(website_url from '^[a-z]+://([^/:?#]+)'), '^www\\.', '')) = ANY(${domains})`
      : Promise.resolve([]),
    prisma.business.findMany({ where: { city: { equals: batch.city, mode: 'insensitive' } }, select: { name: true } }),
  ]);
  const seenIds = new Set(existingIds.map((row) => row.osmId));
  const seenDomains = new Set(existingSites.map((row) => row.domain));
  const seenNames = new Set(existingNames.flatMap((row) => row.name ? [row.name.trim().toLowerCase()] : []));

  const rows: Array<Prisma.BusinessCreateManyInput & { email: string | null }> = [];
  for (const { item, website, socialOnly, track, noun } of candidates) {
    const domain = website ? domainOf(website) : null;
    const nameKey = item.name.trim().toLowerCase();
    if (seenIds.has(`overture/${item.id}`) || (domain && seenDomains.has(domain)) || seenNames.has(nameKey)) { skipped.duplicate++; continue; }
    if (domain) seenDomains.add(domain);
    seenNames.add(nameKey);
    let timezone: string | undefined;
    try { timezone = tzLookup(item.lat, item.lon); } catch { timezone = undefined; }
    rows.push({
      osmId: `overture/${item.id}`,
      name: item.name,
      niche: noun,
      city: batch.city,
      country: batch.country,
      websiteUrl: website,
      track,
      phone: item.phone,
      latitude: item.lat,
      longitude: item.lon,
      timezone,
      socialOnly,
      status: 'new',
      // A known email makes a lead far more likely to become a draft, so it is researched first.
      score: item.email ? 50 : 40,
      findings: track === 'no_site' ? ['no_website_listing', ...(socialOnly ? ['social_only'] : [])] : Prisma.JsonNull,
      scoreSignals: track === 'no_site'
        ? [{ key: 'operating_evidence', evidence: item.phone ? 'Phone number is listed in Overture Maps open data' : 'Business is listed in Overture Maps open data' }]
        : Prisma.JsonNull,
      osmTags: { source: 'overture', release: batch.release, category: item.category, taxonomy: item.taxonomy },
      callScript: track === 'no_site' ? `Hi, I found ${item.name} in ${batch.city}'s public business listings. Is the person who handles your website or online bookings available?` : null,
      email: item.email,
    });
  }

  const inserted = rows.length
    ? (await prisma.business.createMany({ data: rows.map(({ email: _email, ...row }) => row), skipDuplicates: true })).count
    : 0;
  let withEmail = 0;
  const emailRows = rows.filter((row) => row.email);
  if (emailRows.length) {
    const stored = await prisma.business.findMany({ where: { osmId: { in: emailRows.map((row) => row.osmId!) } }, select: { id: true, osmId: true, websiteUrl: true, latitude: true, longitude: true } });
    const emailBySource = new Map(emailRows.map((row) => [row.osmId, row.email!]));
    for (const business of stored) {
      const email = emailBySource.get(business.osmId);
      if (!email) continue;
      // Cite the business's own site when the address is on its domain; otherwise cite the open-data listing.
      const site = business.websiteUrl && domainOf(business.websiteUrl) === email.split('@')[1]?.toLowerCase() ? business.websiteUrl : null;
      const before = await prisma.contact.count({ where: { businessId: business.id } });
      await addContactIfAllowed(business.id, email, site ?? `https://explore.overturemaps.org/#18/${business.latitude}/${business.longitude}`);
      if (await prisma.contact.count({ where: { businessId: business.id } }) > before) withEmail++;
    }
  }
  if (inserted) {
    activity('discover', `Imported ${inserted} new ${inserted === 1 ? 'business' : 'businesses'} in ${batch.city} from Overture Maps open data (${withEmail} with a published email)`, 'success');
  }
  return { received: batch.items.length, inserted, withEmail, skipped };
}
