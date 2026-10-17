// Read-only readiness check. It never sends email, never writes to the database and never calls Gmail.
// Usage: pnpm --filter @outreach/backend preflight            (dry-run readiness)
//        pnpm --filter @outreach/backend preflight -- --live   (also enforce live-send requirements)
import { env } from './env.js';
import { disconnectDb, prisma } from './db.js';

type Level = 'PASS' | 'WARN' | 'FAIL';
const results: Array<{ level: Level; name: string; detail: string }> = [];
const record = (level: Level, name: string, detail: string) => results.push({ level, name, detail });
const live = process.argv.includes('--live');

function placeholder(value: string | undefined) {
  const text = (value ?? '').trim();
  return !text || /^change-me|^generate-a|^xxxx|your name|your business postal/i.test(text);
}

function checkEnvironment() {
  const owner = env.OWNER_EMAIL?.trim();
  record(owner && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner) ? 'PASS' : 'FAIL', 'OWNER_EMAIL', owner ? 'valid email configured' : 'missing or invalid');
  for (const name of ['SESSION_SECRET', 'OTP_PEPPER']) {
    const value = env[name]?.trim() ?? '';
    record(!placeholder(value) && value.length >= 32 ? 'PASS' : 'FAIL', name, 'must be at least 32 random characters');
  }
  record(!placeholder(env.TICK_SECRET) && (env.TICK_SECRET?.length ?? 0) >= 24 ? 'PASS' : 'FAIL', 'TICK_SECRET', 'must be a long random string');
  try {
    const key = Buffer.from(env.GMAIL_TOKEN_ENCRYPTION_KEY?.trim() ?? '', 'base64');
    record(key.length === 32 ? 'PASS' : 'FAIL', 'GMAIL_TOKEN_ENCRYPTION_KEY', 'must be a base64-encoded 32-byte key');
  } catch {
    record('FAIL', 'GMAIL_TOKEN_ENCRYPTION_KEY', 'could not be decoded');
  }
  record(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && !/xxxx/.test(`${env.GOOGLE_CLIENT_ID}${env.GOOGLE_CLIENT_SECRET}`) ? 'PASS' : 'FAIL', 'Google OAuth client', 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET');
  const dry = env.DRY_RUN !== 'false';
  record(dry ? 'PASS' : live ? 'WARN' : 'FAIL', 'DRY_RUN', dry ? 'true: no real email will be sent' : 'false: live sending is ENABLED');
  record(!placeholder(env.SENDER_NAME) ? 'PASS' : live ? 'FAIL' : 'WARN', 'SENDER_NAME', 'real sender name');
  record(!placeholder(env.POSTAL_ADDRESS) ? 'PASS' : live ? 'FAIL' : 'WARN', 'POSTAL_ADDRESS', 'required in every outgoing footer');
  record(env.APP_ORIGIN?.startsWith('https://') ? 'PASS' : live ? 'FAIL' : 'WARN', 'APP_ORIGIN', 'HTTPS origin required for unsubscribe links and WebAuthn');
  record(env.LLM_API_KEY?.trim() ? 'PASS' : 'WARN', 'LLM_API_KEY', env.LLM_API_KEY?.trim() ? 'LLM drafting enabled' : 'not set: every draft will be a template needing manual writing');
  record(env.PAGESPEED_API_KEY?.trim() ? 'PASS' : 'WARN', 'PAGESPEED_API_KEY', 'optional: enables performance/SEO/accessibility findings');
  record(env.TAVILY_API_KEY?.trim() || env.HUNTER_API_KEY?.trim() ? 'PASS' : 'WARN', 'Contact search', env.TAVILY_API_KEY?.trim() || env.HUNTER_API_KEY?.trim()
    ? `enabled: ${[env.TAVILY_API_KEY?.trim() && 'Tavily', env.HUNTER_API_KEY?.trim() && 'Hunter.io'].filter(Boolean).join(' + ')}`
    : 'optional: set TAVILY_API_KEY and/or HUNTER_API_KEY to search the web for published emails');
  const cap = Number(env.DAILY_CAP ?? 10);
  record(Number.isSafeInteger(cap) && cap >= 1 && cap <= 1000 ? 'PASS' : 'FAIL', 'DAILY_CAP', `${env.DAILY_CAP ?? 10}`);
}

async function checkDatabase() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    record('PASS', 'Database', 'reachable');
  } catch (error) {
    record('FAIL', 'Database', `unreachable: ${error instanceof Error ? error.message.split('\n').pop() : 'unknown error'}`);
    return;
  }
  try {
    const [owners, markets, campaigns, lease, tick, gmailToken, drafts, dryRuns, liveSent, arms, brain] = await Promise.all([
      prisma.adminUser.count({ where: { role: 'owner' } }),
      prisma.market.count({ where: { enabled: true } }),
      prisma.campaign.count({ where: { active: true } }),
      prisma.lease.count({ where: { id: 1 } }),
      prisma.appSetting.findUnique({ where: { key: 'tick_last_finished' }, select: { value: true } }),
      prisma.integrationSecret.findUnique({ where: { id: 'gmail_refresh_token' }, select: { id: true } }),
      prisma.email.count({ where: { status: 'drafted' } }),
      prisma.email.count({ where: { gmailMessageId: 'dry-run' } }),
      prisma.email.count({ where: { status: 'sent', gmailMessageId: { not: 'dry-run' } } }),
      prisma.agentArm.count(),
      prisma.appSetting.findUnique({ where: { key: 'brain_settings' }, select: { value: true } }),
    ]);
    record(owners === 1 ? 'PASS' : 'FAIL', 'Owner account', `${owners} owner(s); expected exactly 1`);
    record(markets > 0 ? 'PASS' : 'FAIL', 'Enabled markets', markets > 0 ? `${markets} enabled` : 'enable at least one market on the Markets page');
    record(campaigns > 0 ? 'PASS' : 'FAIL', 'Active campaigns', `${campaigns} active`);
    record(lease > 0 ? 'PASS' : 'FAIL', 'Tick lease row', lease > 0 ? 'present' : 'missing: ticks cannot run');
    record(typeof tick?.value === 'string' ? 'PASS' : 'WARN', 'Tick', typeof tick?.value === 'string' ? `last finished ${tick.value}` : 'no tick has completed yet');
    record(gmailToken || env.GMAIL_REFRESH_TOKEN?.trim() ? 'PASS' : live ? 'FAIL' : 'WARN', 'Gmail connection', gmailToken || env.GMAIL_REFRESH_TOKEN?.trim() ? 'refresh token stored' : 'not connected (needed for replies, OTP email and live sending)');
    record('PASS', 'Pipeline', `${drafts} drafts awaiting review; ${dryRuns} dry-run sends recorded`);
    record(live && dryRuns > 0 ? 'WARN' : 'PASS', 'Dry-run history', dryRuns ? 'dry-run sends are ignored by learning, but check analytics before going live' : 'none');
    record('PASS', 'Real sends so far', String(liveSent));
    const frozen = brain?.value && typeof brain.value === 'object' && !Array.isArray(brain.value) && (brain.value as Record<string, unknown>).frozen === true;
    record(frozen ? 'WARN' : 'PASS', 'Learning', `${arms} arm rows; ${frozen ? 'learning is FROZEN' : 'learning is active'}`);
  } catch (error) {
    record('FAIL', 'Schema', `a required table or column is missing; run the migrations first (${error instanceof Error ? error.message.split('\n').pop() : 'unknown error'})`);
  }
}

try {
  checkEnvironment();
  await checkDatabase();
} finally {
  await disconnectDb();
}
for (const row of results) console.log(`${row.level.padEnd(4)}  ${row.name.padEnd(28)} ${row.detail}`);
const failures = results.filter((row) => row.level === 'FAIL').length;
const warnings = results.filter((row) => row.level === 'WARN').length;
console.log(`\n${failures} failure(s), ${warnings} warning(s) in ${live ? 'LIVE' : 'dry-run'} mode.`);
process.exit(failures ? 1 : 0);
