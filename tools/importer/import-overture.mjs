// Weekly open-data import: Overture Maps places -> backend lead pool.
// Runs in GitHub Actions (see .github/workflows/import-businesses.yml); Render's free instance is too small for DuckDB.
//
// Env: BACKEND_PUBLIC_URL, TICK_SECRET, optional MAX_PER_CITY (default 1500), CONTACT_EMAIL (Nominatim etiquette).

import { DuckDBInstance } from '@duckdb/node-api';

const backend = process.env.BACKEND_PUBLIC_URL?.replace(/\/+$/, '');
const secret = process.env.TICK_SECRET;
const maxPerCity = Math.min(Math.max(Number(process.env.MAX_PER_CITY ?? 1500) || 1500, 50), 5000);
const BATCH = 400;
if (!backend || !secret) {
  console.log('::warning::Set the BACKEND_PUBLIC_URL and TICK_SECRET repository secrets to enable the importer.');
  process.exit(0);
}

async function api(path, init = {}) {
  // Render free instances can take ~1 minute to wake up.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${backend}${path}`, {
        ...init,
        headers: { 'x-tick-key': secret, 'content-type': 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(120_000),
      });
      if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return response.json();
    } catch (error) {
      if (attempt >= 3) throw error;
      console.log(`Retrying ${path} after: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    }
  }
}

async function latestRelease() {
  const response = await fetch('https://overturemaps-us-west-2.s3.amazonaws.com/?list-type=2&prefix=release/&delimiter=/');
  const releases = [...(await response.text()).matchAll(/<Prefix>release\/([^<]+)\/<\/Prefix>/g)].map((match) => match[1]).sort();
  if (!releases.length) throw new Error('Could not list Overture releases');
  return releases.at(-1);
}

async function boundingBox(city, country) {
  const query = new URLSearchParams({ q: `${city}, ${country}`, format: 'jsonv2', limit: '1' });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, {
    headers: { 'user-agent': `EmailAutomator-importer/1.0 (${process.env.CONTACT_EMAIL ?? 'weekly open-data import'})` },
  });
  const [place] = await response.json();
  if (!place?.boundingbox) throw new Error(`Nominatim found no area for ${city}, ${country}`);
  const [south, north, west, east] = place.boundingbox.map(Number);
  return { south, north, west, east };
}

const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;

const targets = await api('/internal/import/targets');
if (!targets.cities.length || !targets.categories.length) {
  console.log('No active targeting (cities and business types) in enabled markets; nothing to import.');
  process.exit(0);
}
const release = await latestRelease();
console.log(`Overture release ${release}; ${targets.cities.length} cities; ${targets.categories.length} categories; up to ${maxPerCity} per city`);

const db = await DuckDBInstance.create(':memory:');
const connection = await db.connect();
await connection.run("INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';");

let totalInserted = 0;
let totalEmails = 0;
for (const { city, country } of targets.cities) {
  try {
    const box = await boundingBox(city, country);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // Nominatim: at most 1 request per second
    const started = Date.now();
    // Franchises often lack a brand in Overture, but their locations share one website domain: drop domains seen 3+ times.
    const reader = await connection.runAndReadAll(`
      WITH base AS (
      SELECT id, names.primary AS name, basic_category AS category, taxonomy.primary AS taxonomy,
             websites[1] AS website, emails[1] AS email, phones[1] AS phone,
             (bbox.ymin + bbox.ymax) / 2 AS lat, (bbox.xmin + bbox.xmax) / 2 AS lon,
             coalesce(len(emails), 0) > 0 AS has_email,
             lower(regexp_extract(websites[1], '^https?://(?:www\.)?([^/:?#]+)', 1)) AS domain
      FROM read_parquet('s3://overturemaps-us-west-2/release/${release}/theme=places/type=place/*.parquet')
      WHERE bbox.xmin BETWEEN ${box.west} AND ${box.east} AND bbox.ymin BETWEEN ${box.south} AND ${box.north}
        AND brand IS NULL
        AND coalesce(operating_status, 'open') = 'open'
        AND confidence >= 0.6
        AND names.primary IS NOT NULL
        AND basic_category IN (${targets.categories.map(sqlString).join(', ')})
        AND (coalesce(len(websites), 0) > 0 OR coalesce(len(emails), 0) > 0 OR coalesce(len(phones), 0) > 0)
      ), counted AS (
        SELECT *, count(*) OVER (PARTITION BY domain) AS domain_count FROM base
      )
      SELECT id, name, category, taxonomy, website, email, phone, lat, lon FROM counted
      WHERE domain IS NULL OR domain = '' OR domain_count <= 2
      ORDER BY has_email DESC, random()
      LIMIT ${maxPerCity}`);
    const items = reader.getRowObjectsJson();
    console.log(`${city}, ${country}: ${items.length} candidate businesses in ${Math.round((Date.now() - started) / 1000)}s`);
    for (let offset = 0; offset < items.length; offset += BATCH) {
      const result = await api('/internal/import', {
        method: 'POST',
        body: JSON.stringify({ source: 'overture', release, city, country, items: items.slice(offset, offset + BATCH) }),
      });
      totalInserted += result.inserted;
      totalEmails += result.withEmail;
      console.log(`  batch ${offset / BATCH + 1}: inserted ${result.inserted}, with email ${result.withEmail}, skipped ${JSON.stringify(result.skipped)}`);
    }
  } catch (error) {
    console.log(`::error::${city}, ${country} failed: ${error.message}`);
  }
}
console.log(`Done: ${totalInserted} new businesses, ${totalEmails} with a published email.`);
