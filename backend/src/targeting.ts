import { prisma } from './db.js';
import { activity } from './activity.js';
import { NICHE_PRESETS, nichePreset } from './niches.js';

// Targeting: which business types and cities campaigns cover.
// "Automatic" (the default) picks cities from data: market scorecard, city size, and learned draft yield per city.

export type TargetingSettings = { mode: 'auto' | 'manual'; cityCount: number; niches: string[] };
export type CityPick = { city: string; country: string; score: number; reason: string };

const SETTINGS_KEY = 'targeting_settings';
const AUTO_KEY = 'targeting_auto';
const REFRESH_MS = 24 * 60 * 60_000;

/** Major cities per supported market: [name, metro population in thousands, language fit for English outreach]. */
export const MAJOR_CITIES: Record<string, Array<[string, number, number]>> = {
  US: [['New York', 19500, 1], ['Los Angeles', 12800, 1], ['Chicago', 9300, 1], ['Dallas', 7900, 1], ['Houston', 7300, 1], ['Atlanta', 6300, 1], ['Washington', 6300, 1], ['Philadelphia', 6200, 1], ['Miami', 6100, 1], ['Phoenix', 5000, 1], ['Boston', 4900, 1], ['San Francisco', 4600, 1], ['Seattle', 4000, 1], ['San Diego', 3300, 1], ['Tampa', 3300, 1], ['Denver', 3000, 1], ['Charlotte', 2800, 1], ['Portland', 2500, 1], ['Austin', 2400, 1], ['Nashville', 2100, 1]],
  CA: [['Toronto', 6200, 1], ['Montreal', 4300, 0.55], ['Vancouver', 2600, 1], ['Calgary', 1600, 1], ['Edmonton', 1500, 1], ['Ottawa', 1400, 0.9], ['Winnipeg', 850, 1], ['Quebec City', 840, 0.4], ['Hamilton', 790, 1], ['Kitchener', 600, 1], ['London', 550, 1], ['Halifax', 480, 1], ['Victoria', 400, 1], ['Saskatoon', 340, 1]],
  GB: [['London', 9600, 1], ['Manchester', 2900, 1], ['Birmingham', 2900, 1], ['Leeds', 1900, 1], ['Glasgow', 1700, 1], ['Liverpool', 1400, 1], ['Sheffield', 1400, 1], ['Bristol', 1100, 1], ['Newcastle upon Tyne', 1100, 1], ['Edinburgh', 900, 1], ['Nottingham', 900, 1], ['Cardiff', 500, 1]],
  AU: [['Sydney', 5400, 1], ['Melbourne', 5200, 1], ['Brisbane', 2700, 1], ['Perth', 2300, 1], ['Adelaide', 1400, 1], ['Gold Coast', 700, 1], ['Canberra', 470, 1]],
  AE: [['Dubai', 3600, 0.9], ['Sharjah', 1800, 0.8], ['Abu Dhabi', 1500, 0.9]],
  SG: [['Singapore', 5900, 1]],
  DE: [['Berlin', 3800, 0.6], ['Hamburg', 1900, 0.55], ['Munich', 1500, 0.55], ['Cologne', 1100, 0.55], ['Frankfurt', 770, 0.6]],
  NL: [['Amsterdam', 2400, 0.85], ['Rotterdam', 650, 0.8], ['The Hague', 550, 0.8], ['Utrecht', 360, 0.8]],
  IE: [['Dublin', 1450, 1], ['Cork', 220, 1], ['Limerick', 100, 1], ['Galway', 85, 1]],
  NZ: [['Auckland', 1700, 1], ['Wellington', 420, 1], ['Christchurch', 400, 1]],
};

type MarketRow = { code: string; name: string; clientValueScore: number; leadSupplyScore: number; emailYieldScore: number; responseScore: number; communicationFitScore: number; compliancePenalty: number };

/** Same prior as the Markets scorecard, without per-request evidence. */
export function marketPriorScore(market: MarketRow) {
  const prior = (market.clientValueScore * 30 + market.leadSupplyScore * 20 + market.emailYieldScore * 10 + market.responseScore * 25 + market.communicationFitScore * 10) / 95;
  return Math.max(0, Math.min(100, prior - market.compliancePenalty));
}

export type CityStats = { researched: number; drafts: number; waiting: number };

/**
 * City score in [0, 1]: market prior (35%), size (25%), learned draft yield (40%).
 * Learned yield starts at a neutral prior and moves toward observed results as research accumulates;
 * untried cities get a small exploration bonus, and cities with an almost empty pool are discounted.
 */
export function scoreCity(input: { marketScore: number; population: number; languageFit: number; stats: CityStats }) {
  const { marketScore, population, languageFit, stats } = input;
  const size = Math.min(1, Math.log10(Math.max(population, 50)) / Math.log10(20_000));
  const evidence = stats.researched / (stats.researched + 30);
  const observedYield = stats.researched ? Math.min(1, (stats.drafts / stats.researched) / 0.3) : 0.5;
  const learned = 0.5 * (1 - evidence) + observedYield * evidence;
  const exploration = 0.08 * (1 - evidence);
  const exhausted = stats.researched >= 100 && stats.waiting < 20 ? 0.6 : 1;
  const score = (0.35 * (marketScore / 100) + 0.25 * size + 0.4 * learned + exploration) * languageFit * exhausted;
  return { score: Math.round(score * 1000) / 1000, evidence, observedYield, exhausted: exhausted < 1 };
}

export async function getTargetingSettings(): Promise<TargetingSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
  const value = (row?.value ?? {}) as Partial<TargetingSettings>;
  const niches = Array.isArray(value.niches) ? value.niches.filter((id) => !!nichePreset(id)) : [];
  return {
    mode: value.mode === 'manual' ? 'manual' : 'auto',
    cityCount: Number.isSafeInteger(value.cityCount) && value.cityCount! >= 1 && value.cityCount! <= 10 ? value.cityCount! : 5,
    niches: niches.length ? niches : NICHE_PRESETS.map((preset) => preset.id),
  };
}

export async function saveTargetingSettings(settings: TargetingSettings) {
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: settings }, update: { value: settings } });
}

async function cityStats(): Promise<Map<string, CityStats>> {
  const rows = await prisma.$queryRaw<Array<{ city: string | null; country: string | null; researched: bigint; drafts: bigint; waiting: bigint }>>`
    SELECT b.city, b.country,
      count(*) FILTER (WHERE b.audited_at IS NOT NULL) AS researched,
      count(DISTINCT e.business_id) AS drafts,
      count(*) FILTER (WHERE b.status = 'new') AS waiting
    FROM businesses b
    LEFT JOIN emails e ON e.business_id = b.id AND e.sequence_step = 0
    GROUP BY b.city, b.country`;
  return new Map(rows.map((row) => [`${row.country}:${(row.city ?? '').toLowerCase()}`, {
    researched: Number(row.researched), drafts: Number(row.drafts), waiting: Number(row.waiting),
  }]));
}

/** Picks the best enabled market, then its best cities. */
export async function chooseCities(count: number): Promise<CityPick[]> {
  const markets = await prisma.market.findMany({ where: { enabled: true } });
  const stats = await cityStats();
  const empty: CityStats = { researched: 0, drafts: 0, waiting: 0 };
  const ranked = markets.filter((market) => MAJOR_CITIES[market.code]).map((market) => {
    const marketScore = marketPriorScore(market);
    const cities = MAJOR_CITIES[market.code]!.map(([city, population, languageFit]) => {
      const cityData = stats.get(`${market.code}:${city.toLowerCase()}`) ?? empty;
      const result = scoreCity({ marketScore, population, languageFit, stats: cityData });
      const parts = [
        `${market.name} scorecard ${Math.round(marketScore)}`,
        `metro ${population >= 1000 ? `${(population / 1000).toFixed(1)}M` : `${population}k`} people`,
        cityData.researched
          ? `${Math.round((cityData.drafts / cityData.researched) * 100)}% of ${cityData.researched} researched leads became drafts`
          : 'not tried yet',
        ...(languageFit < 1 ? ['mostly non-English-speaking, so ranked lower'] : []),
        ...(result.exhausted ? ['lead pool nearly used up'] : []),
      ];
      return { city, country: market.code, score: result.score, reason: parts.join(' · ') };
    }).sort((a, b) => b.score - a.score);
    // A market's strength is the average of its best cities, so one huge city does not decide it alone.
    const top = cities.slice(0, Math.max(1, count));
    return { market, cities, strength: top.reduce((sum, city) => sum + city.score, 0) / top.length };
  }).sort((a, b) => b.strength - a.strength);
  return ranked[0]?.cities.slice(0, count) ?? [];
}

/** Creates/activates one campaign per business type × city and deactivates everything else. */
export async function syncCampaigns(niches: string[], cities: Array<{ city: string; country: string }>) {
  const keep: number[] = [];
  for (const { city, country } of cities) {
    for (const id of niches) {
      const preset = nichePreset(id);
      if (!preset) continue;
      const existing = await prisma.campaign.findFirst({ where: { niche: id, city: { equals: city, mode: 'insensitive' }, country }, select: { id: true } });
      const data = { name: `${preset.label} – ${city}`, niche: id, city, country, osmFilter: preset.osm, active: true };
      keep.push(existing
        ? (await prisma.campaign.update({ where: { id: existing.id }, data, select: { id: true } })).id
        : (await prisma.campaign.create({ data, select: { id: true } })).id);
    }
  }
  if (keep.length) await prisma.campaign.updateMany({ where: { id: { notIn: keep } }, data: { active: false } });
}

export async function lastAutoPicks() {
  const row = await prisma.appSetting.findUnique({ where: { key: AUTO_KEY } });
  return (row?.value ?? null) as { at: string; picks: CityPick[] } | null;
}

/** In automatic mode, re-picks cities (daily, or when forced) and syncs campaigns. */
export async function refreshAutoTargeting(options: { force?: boolean } = {}) {
  const settings = await getTargetingSettings();
  if (settings.mode !== 'auto') return null;
  const last = await lastAutoPicks();
  if (!options.force && last && Date.now() - new Date(last.at).getTime() < REFRESH_MS) return last;
  const picks = await chooseCities(settings.cityCount);
  if (!picks.length) {
    activity('discover', 'Automatic targeting found no enabled market with known cities; enable a market on the Markets page', 'warn');
    return last;
  }
  await syncCampaigns(settings.niches, picks);
  const value = { at: new Date().toISOString(), picks };
  await prisma.appSetting.upsert({ where: { key: AUTO_KEY }, create: { key: AUTO_KEY, value }, update: { value } });
  const changed = !last || last.picks.map((pick) => `${pick.country}:${pick.city}`).join('|') !== picks.map((pick) => `${pick.country}:${pick.city}`).join('|');
  if (changed) {
    activity('discover', `Automatic targeting chose ${picks.map((pick) => `${pick.city}, ${pick.country}`).join('; ')} (${settings.niches.length} business types)`, 'success');
  }
  return value;
}
