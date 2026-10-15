import { env } from './env.js';
import { prisma } from './db.js';
import { Prisma } from '@prisma/client';
import { gmailAccessToken } from './gmail.js';
import { lookup, resolveMx } from 'node:dns/promises';
import { isIP } from 'node:net';
import { load } from 'cheerio';
import tzLookup from 'tz-lookup';
import sharp from 'sharp';
import { randomUUID } from 'node:crypto';
import { nextRecipientWindow, SEND_PLAN_MIN_NOTICE_MS } from './scheduling.js';
import { unsubscribeUrl } from './unsubscribe.js';
import { classifyReply } from './reply-classification.js';
import { getPortfolioSettings, portfolioEmailFooter } from './portfolio.js';
import { notifyAdminsOfReply, runNotificationMaintenance } from './notifications.js';
import { getEffectiveDailyCap } from './warmup.js';
import { createPlansForEligibleMarkets } from './send-plans.js';
import { lookupCompaniesHouse } from './companies-house.js';
import { recordPageSpeedCall } from './usage-meter.js';
import { activity, runStage, tickFinished, tickStarted } from './activity.js';
import { chooseAngle, chooseCandidates, chooseSubjectStyle, getDraftingMemory, runBrainCycle } from './brain.js';
import { containsBannedPhrase, STYLE_HINTS, type SubjectStyle } from './brain-math.js';

const DRY = env.DRY_RUN !== 'false';
const configuredTokenBudget = Number(env.LLM_DAILY_TOKEN_BUDGET ?? 30000);
const configuredRecontactDays = Number(env.RECONTACT_COOLDOWN_DAYS ?? 90);
const configuredHoldMinutes = Number(env.SEND_HOLD_MINUTES ?? 30);
const TOKEN_BUDGET = Number.isSafeInteger(configuredTokenBudget) && configuredTokenBudget >= 0 ? configuredTokenBudget : 30000;
const RECONTACT_DAYS = Number.isSafeInteger(configuredRecontactDays) && configuredRecontactDays > 0 ? configuredRecontactDays : 90;
const HOLD_MINUTES = Number.isSafeInteger(configuredHoldMinutes) && configuredHoldMinutes >= 0 ? configuredHoldMinutes : 30;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
// overpass-api.de is the reliable public instance; private.coffee is a slower fallback (kumi.systems kept timing out).
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const LABEL: Record<string, string> = {
  no_https: 'the site loads over plain HTTP, so browsers show a "Not secure" warning',
  not_mobile_friendly: 'the homepage has no mobile viewport setting, so it may not adapt to phone screens',
  missing_meta: 'there is no meta description on the homepage',
  old_copyright: 'the homepage footer shows a copyright year that is more than three years old',
  no_booking_link: 'no online booking or ordering link was found on the homepage',
  slow_lcp: 'the mobile PageSpeed Largest Contentful Paint is slower than 2.5 seconds',
  no_website_listing: "I couldn't find a website linked from this business's public listing",
  social_only: 'the public listing links only to a social-media page',
  phone_no_booking: 'a phone number is listed, but no online booking or ordering link was found',
  mobile_performance: 'mobile PageSpeed performance score is low',
  accessibility: 'mobile PageSpeed accessibility score is low',
  seo: 'mobile PageSpeed SEO score is low',
};

export async function runTick() {
  const now = new Date();
  const got = await prisma.lease.updateMany({
    where: { id: 1, until: { lt: now } },
    data: { until: new Date(now.getTime() + 10 * 60 * 1000) },
  });
  if (!got.count) return;
  tickStarted();
  try {
    await prisma.business.updateMany({
      where: { screenshotExpiresAt: { lte: now } },
      data: { screenshot: null, screenshotExpiresAt: null },
    });
    await runStage('discover', 'Looking for new businesses to add to the lead pool', discover);
    await runStage('audit', 'Researching businesses: website checks, contact discovery and scoring', auditAndDraft);
    await runStage('plan', 'Checking whether a new Send Plan should be announced', createPlansForEligibleMarkets);
    await runStage('replies', 'Checking Gmail for new replies', async () => {
      await pollReplies();
      const fresh = await prisma.replyRecord.groupBy({ by: ['classification'], where: { createdAt: { gte: now } }, _count: { _all: true } });
      const total = fresh.reduce((sum, row) => sum + row._count._all, 0);
      activity('replies', total
        ? `Processed ${total} new ${total === 1 ? 'message' : 'messages'}: ${fresh.map((row) => `${row._count._all} ${(row.classification ?? 'other').replaceAll('_', ' ')}`).join(', ')}`
        : 'No new replies in Gmail', total ? 'success' : 'info');
    });
    await runStage('followups', 'Scheduling follow-ups for silent threads', async () => {
      await scheduleFollowUps();
      const created = await prisma.email.count({ where: { sequenceStep: { gt: 0 }, createdAt: { gte: now } } });
      activity('followups', created ? `Drafted ${created} follow-up ${created === 1 ? 'email' : 'emails'} for your review` : 'No follow-ups due', created ? 'success' : 'info');
    });
    await runStage('learn', 'Updating what the agent has learned from results', async () => {
      await runBrainCycle();
      activity('learn', 'Learning model is up to date');
    });
    await runStage('send', DRY ? 'Checking the send queue (dry run: nothing is really sent)' : 'Checking the send queue', sendDue);
    await runStage('notify', 'Delivering notifications, retries and digests', runNotificationMaintenance);
  } finally {
    await prisma.$transaction([
      prisma.appSetting.upsert({
        where: { key: 'tick_last_finished' },
        create: { key: 'tick_last_finished', value: new Date().toISOString() },
        update: { value: new Date().toISOString() },
      }),
      prisma.lease.update({ where: { id: 1 }, data: { until: new Date(0) } }),
    ]);
    await tickFinished();
  }
}

type GmailMessagePart = {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
};

async function gmailApi(path: string, init: RequestInit = {}) {
  const accessToken = await gmailAccessToken();
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
    ...init,
    headers: new Headers({ authorization: `Bearer ${accessToken}`, ...(init.headers ?? {}) }),
    signal: init.signal ?? AbortSignal.timeout(20000),
  });
  return response;
}

function decodeGmailPart(part: GmailMessagePart): string[] {
  const content: string[] = [];
  if (part.mimeType === 'text/plain' && typeof part.body?.data === 'string') {
    content.push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
  } else if (part.mimeType === 'text/html' && typeof part.body?.data === 'string') {
    content.push(load(Buffer.from(part.body.data, 'base64url').toString('utf8')).root().text());
  }
  for (const child of part.parts ?? []) content.push(...decodeGmailPart(child));
  return content;
}

async function pollReplies() {
  const state = await prisma.gmailSyncState.findUnique({ where: { id: 1 } });
  const profileResponse = await gmailApi('profile');
  if (!profileResponse.ok) throw new Error(`Gmail profile request failed with HTTP ${profileResponse.status}`);
  const profile = await profileResponse.json() as { historyId?: unknown };
  if (typeof profile.historyId !== 'string') throw new Error('Gmail profile did not return a history ID');
  if (!state?.historyId) {
    await prisma.gmailSyncState.upsert({
      where: { id: 1 },
      create: { id: 1, historyId: profile.historyId, lastPolledAt: new Date() },
      update: { historyId: profile.historyId, lastPolledAt: new Date() },
    });
    return;
  }

  const ids = new Set<string>();
  let pageToken: string | null = null;
  let latestHistoryId = state.historyId;
  let historyExpired = false;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ startHistoryId: state.historyId, historyTypes: 'messageAdded', maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const response = await gmailApi(`history?${params.toString()}`);
    if (response.status === 404) {
      historyExpired = true;
      break;
    }
    if (!response.ok) throw new Error(`Gmail history request failed with HTTP ${response.status}`);
    const history = await response.json() as {
      historyId?: unknown;
      nextPageToken?: unknown;
      history?: Array<{ messagesAdded?: Array<{ message?: { id?: unknown } }> }>;
    };
    if (typeof history.historyId === 'string') latestHistoryId = history.historyId;
    for (const event of history.history ?? []) {
      for (const added of event.messagesAdded ?? []) {
        if (typeof added.message?.id === 'string') ids.add(added.message.id);
      }
    }
    if (typeof history.nextPageToken !== 'string') {
      pageToken = null;
      break;
    }
    pageToken = history.nextPageToken;
  }
  if (pageToken) {
    console.warn(JSON.stringify({ level: 'warn', event: 'gmail_history_page_limit', action: 'poll_will_resume_next_tick' }));
    return;
  }
  if (historyExpired) {
    console.warn(JSON.stringify({ level: 'warn', event: 'gmail_history_expired', action: 'falling_back_to_recent_message_scan' }));
    const fallbackSince = state.lastPolledAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const after = Math.floor(fallbackSince.getTime() / 1000);
    let messagePageToken: string | null = null;
    for (let page = 0; page < 10; page++) {
      const params = new URLSearchParams({ q: `after:${after} in:anywhere`, maxResults: '100' });
      if (messagePageToken) params.set('pageToken', messagePageToken);
      const response = await gmailApi(`messages?${params.toString()}`);
      if (!response.ok) throw new Error(`Gmail recent-message scan failed with HTTP ${response.status}`);
      const result = await response.json() as {
        messages?: Array<{ id?: unknown }>;
        nextPageToken?: unknown;
      };
      for (const message of result.messages ?? []) {
        if (typeof message.id === 'string') ids.add(message.id);
      }
      if (typeof result.nextPageToken !== 'string') {
        messagePageToken = null;
        break;
      }
      messagePageToken = result.nextPageToken;
    }
    if (messagePageToken) {
      console.warn(JSON.stringify({ level: 'warn', event: 'gmail_recent_message_page_limit', action: 'scan_will_resume_next_tick' }));
      return;
    }
    latestHistoryId = profile.historyId;
  }

  const humanReplyIds: string[] = [];
  for (const messageId of ids) {
    if (await prisma.replyRecord.findUnique({ where: { gmailMessageId: messageId }, select: { id: true } })) continue;
    const response = await gmailApi(`messages/${encodeURIComponent(messageId)}?format=full`);
    if (!response.ok) {
      if (response.status === 404) {
        console.warn(JSON.stringify({ level: 'warn', event: 'gmail_message_removed_before_processing' }));
        continue;
      }
      throw new Error(`Gmail message fetch failed with HTTP ${response.status}`);
    }
    const message = await response.json() as {
      id?: unknown;
      threadId?: unknown;
      snippet?: unknown;
      internalDate?: unknown;
      payload?: { headers?: Array<{ name?: unknown; value?: unknown }>; body?: { data?: string }; parts?: GmailMessagePart[] };
    };
    if (typeof message.threadId !== 'string' || typeof message.id !== 'string') continue;
    const headers = new Map((message.payload?.headers ?? []).flatMap((header) =>
      typeof header.name === 'string' && typeof header.value === 'string'
        ? [[header.name.toLowerCase(), header.value] as const]
        : [],
    ));
    const from = headers.get('from') ?? '';
    if (from.toLowerCase().includes(env.OWNER_EMAIL.toLowerCase())) continue;
    const subject = headers.get('subject') ?? '';
    const body = decodeGmailPart({ parts: message.payload?.parts ?? [], body: message.payload?.body }).join('\n').slice(0, 20000);
    const classification = classifyReply(from, subject, headers, body);
    const sentEmail = await prisma.email.findFirst({
      where: { gmailThreadId: message.threadId, status: 'sent' },
      orderBy: { sentAt: 'desc' },
      select: { id: true, businessId: true, contactId: true, contact: { select: { email: true } } },
    });
    if (!sentEmail) continue;
    const receivedAt = typeof message.internalDate === 'string' && Number.isFinite(Number(message.internalDate))
      ? new Date(Number(message.internalDate))
      : new Date();
    await prisma.$transaction(async (transaction) => {
      await transaction.replyRecord.create({
        data: {
          gmailMessageId: message.id as string,
          threadId: message.threadId as string,
          emailId: sentEmail.id,
          classification,
          snippet: typeof message.snippet === 'string' ? message.snippet.slice(0, 180) : null,
          receivedAt,
        },
      });
      if (['unsubscribe', 'complaint', 'bounce'].includes(classification) && sentEmail.contact?.email) {
        const reason = classification === 'unsubscribe' ? 'reply_unsubscribe' : classification === 'complaint' ? 'complaint' : 'hard_bounce';
        await transaction.suppression.upsert({
          where: { email: sentEmail.contact.email },
          create: { email: sentEmail.contact.email, reason },
          update: { reason },
        });
        await transaction.contactLedger.upsert({
          where: { email: sentEmail.contact.email },
          create: { email: sentEmail.contact.email, domain: sentEmail.contact.email.split('@')[1] ?? '', businessId: sentEmail.businessId, status: 'blocked', blockReason: reason },
          update: { status: 'blocked', blockReason: reason },
        });
        await transaction.email.updateMany({
          where: {
            contactId: sentEmail.contactId,
            status: { in: ['drafted', 'held', 'approved'] },
          },
          data: { status: 'rejected', followUpDueAt: null, scheduledFor: null, holdUntil: null, error: reason },
        });
      } else if (classification === 'human') {
        await transaction.email.updateMany({
          where: { gmailThreadId: message.threadId as string, status: 'sent' },
          data: { followUpDueAt: null },
        });
        if (sentEmail.businessId !== null) {
          await transaction.business.update({ where: { id: sentEmail.businessId }, data: { status: 'replied' } });
          await transaction.deal.upsert({
            where: { businessId: sentEmail.businessId },
            create: { businessId: sentEmail.businessId, stage: 'replied' },
            update: {},
          });
        }
        if (sentEmail.contact?.email) {
          await transaction.contactLedger.upsert({
            where: { email: sentEmail.contact.email },
            create: { email: sentEmail.contact.email, domain: sentEmail.contact.email.split('@')[1] ?? '', businessId: sentEmail.businessId, status: 'replied', blockReason: 'human_reply' },
            update: { status: 'replied', blockReason: 'human_reply', eligibleAfter: null },
          });
        }
      }
    });
    if (classification === 'human') {
      humanReplyIds.push(message.id as string);
      await addRepliedLabel(message.id as string);
    }
  }
  await prisma.gmailSyncState.upsert({
    where: { id: 1 },
    create: { id: 1, historyId: latestHistoryId, lastPolledAt: new Date() },
    update: { historyId: latestHistoryId, lastPolledAt: new Date() },
  });
  if (humanReplyIds.length) {
    try {
      await notifyAdminsOfReply(humanReplyIds.sort().join(','));
    } catch (error) {
      console.error('[push] could not dispatch reply notifications', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }
}

async function addRepliedLabel(messageId: string) {
  try {
    const listResponse = await gmailApi('labels');
    if (!listResponse.ok) throw new Error(`Gmail label list failed with HTTP ${listResponse.status}`);
    const list = await listResponse.json() as { labels?: Array<{ id?: string; name?: string }> };
    let labelId = list.labels?.find((label) => label.name === 'Outreach/Replied')?.id;
    if (!labelId) {
      const createResponse = await gmailApi('labels', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Outreach/Replied', labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
      });
      if (!createResponse.ok) throw new Error(`Gmail label creation failed with HTTP ${createResponse.status}`);
      const created = await createResponse.json() as { id?: unknown };
      if (typeof created.id !== 'string') throw new Error('Gmail did not return a label ID');
      labelId = created.id;
    }
    const update = await gmailApi(`messages/${encodeURIComponent(messageId)}/modify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ addLabelIds: [labelId] }),
    });
    if (!update.ok) throw new Error(`Gmail message labeling failed with HTTP ${update.status}`);
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'gmail_replied_label_failed', message: errorMessage(error) }));
  }
}

async function scheduleFollowUps() {
  const due = await prisma.email.findMany({
    where: {
      status: 'sent',
      sequenceStep: { lt: 2 },
      followUpDueAt: { lte: new Date() },
      gmailThreadId: { not: null },
      contact: { is: { email: { not: null } } },
    },
    orderBy: { followUpDueAt: 'asc' },
    take: 20,
    include: {
      business: { select: { name: true, status: true } },
      contact: { select: { email: true } },
    },
  });
  for (const previous of due) {
    const threadId = previous.gmailThreadId!;
    const existingReply = await prisma.replyRecord.findFirst({ where: { threadId, classification: { in: ['human', 'auto_reply', 'unsubscribe', 'complaint', 'bounce'] } }, select: { id: true } });
    const suppressed = previous.contact?.email
      ? await prisma.suppression.findUnique({ where: { email: previous.contact.email }, select: { email: true } })
      : null;
    const businessStatus = previous.business?.status;
    if (existingReply || suppressed || businessStatus === 'replied') {
      await prisma.email.updateMany({ where: { id: previous.id, status: 'sent' }, data: { followUpDueAt: null } });
      continue;
    }
    const recipientEmail = previous.contact?.email;
    if (!recipientEmail) continue;
    const businessName = (previous.business?.name ?? 'your website').replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 120);
    const followUpBody = `Hi,\n\nJust following up on my earlier note about ${businessName}. Would it be useful if I sent a short outline?\n\n${env.SENDER_NAME}`;
    const created = await prisma.$transaction(async (transaction) => {
      const claimed = await transaction.email.updateMany({
        where: { id: previous.id, status: 'sent', followUpDueAt: { lte: new Date() } },
        data: { followUpDueAt: null },
      });
      if (!claimed.count) return false;
      await transaction.email.create({
        data: {
          businessId: previous.businessId,
          contactId: previous.contactId,
          subject: previous.subject,
          origSubject: previous.subject,
          body: followUpBody,
          origBody: followUpBody,
          status: 'drafted',
          sequenceStep: previous.sequenceStep + 1,
          gmailThreadId: threadId,
          draftAngle: `follow-up-${previous.sequenceStep + 1}`,
        },
      });
      if (previous.businessId !== null) {
        await transaction.business.update({ where: { id: previous.businessId }, data: { status: 'review' } });
      }
      return true;
    });
    if (created) console.info(JSON.stringify({ level: 'info', event: 'follow_up_draft_created', emailId: previous.id, sequenceStep: previous.sequenceStep + 1 }));
  }
}

function isDisposableEmail(email: string) {
  const domain = email.split('@')[1]?.toLowerCase();
  return Boolean(domain && [
    'mailinator.com', 'yopmail.com', 'tempmail.com', 'guerrillamail.com',
    '10minutemail.com', 'trashmail.com', 'dispostable.com',
  ].some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`)));
}

const DISCOVERY_REFILL_BELOW = 15;
const DISCOVERY_MIN_INTERVAL_MS = 30 * 60_000;
const DISCOVERY_FAILURE_BACKOFF_MS = 2 * 60 * 60_000;
const DISCOVERY_STATE_KEY = 'discovery_last_attempt';

async function discover() {
  const n = await prisma.business.count({ where: { status: { in: ['new', 'review', 'call_queue'] } } });
  if (n >= DISCOVERY_REFILL_BELOW) {
    activity('discover', `${n} businesses are already waiting, so no new search this cycle (searches when fewer than ${DISCOVERY_REFILL_BELOW} remain)`);
    return;
  }
  // Public Overpass servers refuse IPs that query too often, so space searches out.
  const lastAttempt = await prisma.appSetting.findUnique({ where: { key: DISCOVERY_STATE_KEY } });
  const last = lastAttempt?.value as { at?: string; ok?: boolean } | undefined;
  if (last?.at) {
    const waitMs = (last.ok ? DISCOVERY_MIN_INTERVAL_MS : DISCOVERY_FAILURE_BACKOFF_MS) - (Date.now() - new Date(last.at).getTime());
    if (waitMs > 0) {
      activity('discover', `${last.ok ? 'Searched recently' : 'Last search failed'}; next OpenStreetMap search in about ${Math.ceil(waitMs / 60_000)} min`);
      return;
    }
  }
  let searchOk = true;
  const recordAttempt = (ok: boolean) => prisma.appSetting.upsert({
    where: { key: DISCOVERY_STATE_KEY },
    create: { key: DISCOVERY_STATE_KEY, value: { at: new Date().toISOString(), ok } },
    update: { value: { at: new Date().toISOString(), ok } },
  });
  let remaining = 30 - n;
  const campaigns = await prisma.campaign.findMany({ where: { active: true } });
  if (!campaigns.length) activity('discover', 'No active campaigns. Add a niche and city to start finding businesses.', 'warn');
  else activity('discover', `Lead pool has room for ${remaining} more; searching ${campaigns.length} ${campaigns.length === 1 ? 'campaign' : 'campaigns'}`);
  for (const c of campaigns) {
    if (remaining <= 0) break;
    try {
      const filter = c.osmFilter.split('=');
      if (filter.length !== 2 || !filter[0] || !filter[1] || !c.city) {
        throw new Error('Campaign must have a city and an OSM filter in key=value format');
      }
      const countryCode = countryCodeFor(c.country);
      if (!countryCode) {
        console.info(JSON.stringify({ level: 'info', event: 'discovery_market_unrecognized', city: c.city, country: c.country }));
        activity('discover', `Skipped ${c.city}: country "${c.country ?? 'unknown'}" is not a supported market`, 'warn');
        continue;
      }
      const market = await prisma.market.findUnique({ where: { code: countryCode }, select: { enabled: true } });
      if (!market?.enabled) {
        console.info(JSON.stringify({ level: 'info', event: 'discovery_market_disabled', city: c.city, country: countryCode }));
        activity('discover', `Skipped ${c.city}: the ${countryCode} market is not enabled`, 'warn');
        continue;
      }
      const [key, value] = filter;
      if (!/^[a-zA-Z0-9:_-]+$/.test(key) || !/^[a-zA-Z0-9:_ -]+$/.test(value)) {
        throw new Error('Campaign OSM filter contains unsupported characters');
      }
      activity('discover', `Locating ${c.city}, ${countryCode} on the map`);
      const city = await geocodeCity(c.city, countryCode);
      const area = city.osmType === 'relation' && city.osmId
        ? `area(${Number(city.osmId) + 3_600_000_000})->.a;`
        : city.osmType === 'way' && city.osmId
          ? `area(${Number(city.osmId) + 2_400_000_000})->.a;`
          : '';
      const spatialFilter = area ? '(area.a)' : `(around:15000,${city.latitude},${city.longitude})`;
      const listingQuery = `[out:json][timeout:90];${area}nwr["${key}"="${value}"]["name"]${spatialFilter};out tags center 300;`;
      activity('discover', `Searching OpenStreetMap for ${c.niche} businesses in ${c.city} (this can take up to a minute)`);
      const listingResult = await queryOverpass(listingQuery);
      activity('discover', `OpenStreetMap returned ${listingResult.elements.length} listings; filtering out chains and ineligible ones`);
      const result = { endpoints: [listingResult.endpoint], elements: listingResult.elements };
      const localNameCounts = new Map<string, number>();
      for (const element of result.elements) {
        const normalizedName = element.tags?.name?.trim().toLowerCase();
        if (normalizedName) localNameCounts.set(normalizedName, (localNameCounts.get(normalizedName) ?? 0) + 1);
      }
      const candidates: Array<Prisma.BusinessCreateManyInput & { osmId: string; email?: string }> = [];
      let malformedElements = 0;
      for (const element of result.elements) {
        if (!element.type || element.id === undefined || !element.tags) {
          malformedElements++;
          continue;
        }
        const tags = element.tags;
        const name = tags.name?.trim();
        if (!name || isIneligible(tags)) continue;
        const nameMatches = localNameCounts.get(name.toLowerCase()) ?? 0;
        if (nameMatches >= 3 || (nameMatches >= 2 && /\b(ltd|limited|inc|incorporated|llc|corp|corporation)\b/i.test(name))) continue;
        const website = tags.website ?? tags['contact:website'] ?? tags.url;
        if (website && isDirectoryUrl(website)) continue;
        let websiteUrl: string | null = null;
        if (website) {
          try { websiteUrl = normalizeWebsite(website); }
          catch {
            console.info(JSON.stringify({ level: 'info', event: 'discovery_invalid_website', osmId: `${element.type}/${element.id}` }));
            continue;
          }
        }
        const socialOnly = Boolean(websiteUrl && isSocialUrl(websiteUrl));
        const track = websiteUrl && !socialOnly ? 'site' : 'no_site';
        if (track === 'no_site' && !tags.phone && !tags['contact:phone'] && !tags.opening_hours) continue;
        const latitude = element.center?.lat ?? element.latitude ?? city.latitude;
        const longitude = element.center?.lon ?? element.longitude ?? city.longitude;
        let timezone: string | undefined;
        try { timezone = tzLookup(latitude, longitude); }
        catch (error) {
          console.info(JSON.stringify({ level: 'info', event: 'timezone_lookup_failed', osmId: `${element.type}/${element.id}`, message: errorMessage(error) }));
        }
        const osmEmail = normalizeContactEmail(tags.email ?? tags['contact:email']);
        candidates.push({
          osmId: `${element.type}/${element.id}`,
          name,
          niche: c.niche,
          city: c.city,
          country: countryCode,
          websiteUrl: track === 'site' ? websiteUrl : null,
          track,
          phone: tags.phone ?? tags['contact:phone'] ?? null,
          latitude,
          longitude,
          timezone,
          socialOnly,
          status: 'new',
          findings: track === 'no_site' ? ['no_website_listing', ...(socialOnly ? ['social_only'] : [])] : Prisma.JsonNull,
          scoreSignals: track === 'no_site'
            ? [{ key: 'operating_evidence', evidence: tags.phone || tags['contact:phone'] ? 'Phone number is listed in OpenStreetMap' : 'Opening hours are listed in OpenStreetMap' }]
            : Prisma.JsonNull,
          osmTags: tags,
          callScript: track === 'no_site' ? `Hi, I found ${name} in ${c.city}'s public business listings. Is the person who handles your website or online bookings available?` : null,
          email: osmEmail ?? undefined,
        });
      }
      const limitedCandidates = candidates.slice(0, remaining);
      const inserted = limitedCandidates.length
        ? (await prisma.business.createMany({
            data: limitedCandidates.map(({ email: _email, ...business }) => business),
            skipDuplicates: true,
          })).count
        : 0;
      remaining -= inserted;
      const osmIds = limitedCandidates.map((business) => business.osmId);
      if (osmIds.length) {
        const stored = await prisma.business.findMany({
          where: { osmId: { in: osmIds } },
          select: { id: true, osmId: true, track: true },
        });
        const byOsmId = new Map(candidates.map((business) => [business.osmId, business.email]));
        for (const business of stored) {
          const email = byOsmId.get(business.osmId ?? '');
          if (email) await addContactIfAllowed(business.id, email, `https://www.openstreetmap.org/${business.osmId}`);
        }
      }
      {
        const siteCount = limitedCandidates.filter((business) => business.track === 'site').length;
        activity('discover', inserted
          ? `Added ${inserted} new ${c.niche} ${inserted === 1 ? 'business' : 'businesses'} in ${c.city} (${siteCount} with websites, ${limitedCandidates.length - siteCount} without)`
          : `No new ${c.niche} businesses in ${c.city}; all ${result.elements.length} listings were already known or ineligible`, inserted ? 'success' : 'info');
      }
      console.info(JSON.stringify({
        level: 'info',
        event: 'discovery_campaign_complete',
        city: c.city,
        endpoints: result.endpoints.map((endpoint) => new URL(endpoint).host),
        elements: result.elements.length,
        candidates: limitedCandidates.length,
        inserted,
        malformedElements,
        trackCounts: {
          site: limitedCandidates.filter((business) => business.track === 'site').length,
          no_site: limitedCandidates.filter((business) => business.track === 'no_site').length,
        },
      }));
    } catch (error) {
      console.error(JSON.stringify({
        level: 'error',
        event: 'discovery_campaign_failed',
        city: c.city,
        message: errorMessage(error),
      }));
      activity('discover', `Search in ${c.city} failed: ${errorMessage(error)}`, 'error');
      searchOk = false;
    }
  }
  if (campaigns.length) await recordAttempt(searchOk);
}

type OverpassElement = {
  type?: string;
  id?: number | string;
  tags?: Record<string, string>;
  center?: { lat: number; lon: number };
  latitude?: number;
  longitude?: number;
};

type GeocodedCity = { latitude: number; longitude: number; osmType: string | null; osmId: string | null };

const COUNTRY_CODES: Record<string, string> = {
  'united states': 'US',
  'united states of america': 'US',
  canada: 'CA',
  'united kingdom': 'GB',
  uk: 'GB',
  australia: 'AU',
  'united arab emirates': 'AE',
  singapore: 'SG',
  germany: 'DE',
  netherlands: 'NL',
  ireland: 'IE',
  'new zealand': 'NZ',
};
let lastNominatimRequest = 0;

function countryCodeFor(country: string | null) {
  if (!country) return null;
  const value = country.trim();
  if (/^[A-Za-z]{2}$/.test(value)) return value.toUpperCase();
  return COUNTRY_CODES[value.toLowerCase()] ?? null;
}

async function geocodeCity(cityName: string, countryCode: string): Promise<GeocodedCity> {
  const id = `${countryCode}:${cityName.trim().toLowerCase()}`;
  const cached = await prisma.cityGeoCache.findUnique({ where: { id } });
  if (cached && Date.now() - cached.updatedAt.getTime() < 30 * 24 * 60 * 60 * 1000) {
    return { latitude: cached.latitude, longitude: cached.longitude, osmType: cached.osmType, osmId: cached.osmId };
  }
  const wait = 1000 - (Date.now() - lastNominatimRequest);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastNominatimRequest = Date.now();
  const query = new URLSearchParams({ q: `${cityName}, ${countryCode}`, format: 'jsonv2', limit: '1' });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, {
    headers: {
      accept: 'application/json',
      'user-agent': `EmailAutomator/1.0 (lead research; ${env.OWNER_EMAIL})`,
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Nominatim geocoding failed with HTTP ${response.status}`);
  const payload: unknown = await response.json();
  if (!Array.isArray(payload) || !payload[0] || typeof payload[0] !== 'object') {
    throw new Error(`Nominatim did not find a location for ${cityName}, ${countryCode}`);
  }
  const result = payload[0] as Record<string, unknown>;
  const latitude = Number(result.lat);
  const longitude = Number(result.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw new Error(`Nominatim returned invalid coordinates for ${cityName}, ${countryCode}`);
  }
  const location = {
    latitude,
    longitude,
    osmType: typeof result.osm_type === 'string' ? result.osm_type : null,
    osmId: typeof result.osm_id === 'number' || typeof result.osm_id === 'string' ? String(result.osm_id) : null,
  };
  await prisma.cityGeoCache.upsert({
    where: { id },
    update: { ...location, displayName: typeof result.display_name === 'string' ? result.display_name : null },
    create: { id, ...location, displayName: typeof result.display_name === 'string' ? result.display_name : null },
  });
  return location;
}

function isIneligible(tags: Record<string, string>) {
  if (
    Object.keys(tags).some((key) => /^(disused|abandoned):/.test(key)) ||
    tags.disused === 'yes' ||
    tags.abandoned === 'yes' ||
    tags.office === 'government' ||
    tags.government ||
    tags.amenity === 'social_facility' ||
    tags.nonprofit === 'yes' ||
    tags['check_date'] && Date.now() - Date.parse(tags.check_date) > 2 * 365 * 24 * 60 * 60 * 1000
  ) return true;
  if (tags.brand || tags['brand:wikidata'] || tags.branch || tags['brand:branch']) return true;
  const name = tags.name ?? '';
  if (/\b(starbucks|mcdonald'?s|subway|kfc|burger king|wendy'?s|tim hortons|dunkin|domino'?s|pizza hut)\b/i.test(name)) return true;
  if (/\b(branch|franchise|head office|regional office)\b/i.test(name)) return true;
  return false;
}

function isSocialUrl(value: string) {
  try {
    const host = new URL(normalizeWebsite(value)).hostname.toLowerCase().replace(/^www\./, '');
    return ['facebook.com', 'instagram.com', 'tiktok.com', 'linkedin.com', 'x.com', 'twitter.com'].some(
      (domain) => host === domain || host.endsWith(`.${domain}`),
    );
  } catch {
    return false;
  }
}

function isDirectoryUrl(value: string) {
  try {
    const host = new URL(normalizeWebsite(value)).hostname.toLowerCase().replace(/^www\./, '');
    return [
      'yelp.com', 'tripadvisor.com', 'yellowpages.com', 'foursquare.com',
      'trustpilot.com', 'opentable.com', 'doordash.com', 'ubereats.com',
      'maps.google.com', 'google.com', 'maps.apple.com', 'maps.app.goo.gl',
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function normalizeWebsite(value: string) {
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Business website must use HTTP or HTTPS');
  url.username = '';
  url.password = '';
  return url.toString();
}

function normalizeContactEmail(value: string | undefined) {
  const email = value?.split(/[;,]/, 1)[0]?.trim().toLowerCase();
  return email && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email) ? email : null;
}

function isPersonalEmail(email: string, country: string | null) {
  if (!['GB', 'DE', 'NL', 'IE'].includes(country ?? '')) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  return Boolean(domain && /^(gmail|googlemail|outlook|hotmail|live|yahoo|icloud|protonmail|proton|aol|msn|mail)\./.test(domain));
}

async function hasMailExchange(email: string) {
  const domain = email.split('@')[1];
  if (!domain) return false;
  try {
    return (await resolveMx(domain)).length > 0;
  } catch {
    try {
      return (await lookup(domain, { all: true })).length > 0;
    } catch {
      return false;
    }
  }
}

function isPublicIp(address: string) {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    if (a === undefined || b === undefined) return false;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 88 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0)
    );
  }
  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    return isIP(mapped) === 4 && isPublicIp(mapped);
  }
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(normalized) && !normalized.startsWith('2001:db8:');
}

async function assertPublicUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Website URL must be a public HTTP or HTTPS address without credentials');
  }
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Website URL uses a non-standard port');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicIp(address))) {
    throw new Error('Website host resolves to a private or reserved network address');
  }
}

async function fetchPublicPage(value: string, allow404 = false) {
  let url = value;
  for (let redirects = 0; redirects <= 5; redirects++) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      redirect: 'manual',
      headers: {
        accept: 'text/html,application/xhtml+xml',
        'user-agent': `EmailAutomator/1.0 (website audit; ${env.OWNER_EMAIL})`,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Website returned HTTP ${response.status} without a redirect location`);
      url = new URL(location, url).toString();
      continue;
    }
    if (!response.ok && !(response.status === 404 && allow404)) throw new Error(`Website returned HTTP ${response.status}`);
    return { response, url };
  }
  throw new Error('Website exceeded the five-redirect limit');
}

async function limitedText(response: Response, maximumBytes: number, options: { truncate?: boolean } = {}) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    if (size + part.value.byteLength > maximumBytes) {
      await reader.cancel();
      if (!options.truncate) throw new Error(`Website response exceeds the ${maximumBytes}-byte audit limit`);
      // Meta tags, links and contact details live early in the page; the first N bytes are enough.
      const remaining = maximumBytes - size;
      if (remaining > 0) {
        chunks.push(part.value.subarray(0, remaining));
        size += remaining;
      }
      break;
    }
    size += part.value.byteLength;
    chunks.push(part.value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function robotsAllows(siteUrl: string, path: string) {
  const origin = new URL(siteUrl).origin;
  const { response, url } = await fetchPublicPage(`${origin}/robots.txt`, true).catch((error) => {
    throw new Error(`Could not check robots.txt: ${errorMessage(error)}`);
  });
  if (new URL(url).origin !== origin) throw new Error('robots.txt redirected to another host');
  if (response.status === 404) return true;
  if (!response.ok) throw new Error(`robots.txt returned HTTP ${response.status}`);
  const rules = await limitedText(response, 128_000);
  let active = false;
  let matchedLength = -1;
  let allowed = true;
  for (const raw of rules.split(/\r?\n/)) {
    const line = raw.split('#', 1)[0]?.trim() ?? '';
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const directive = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (directive === 'user-agent') {
      active = value === '*' || value.toLowerCase().startsWith('emailautomator');
      continue;
    }
    if (active && (directive === 'allow' || directive === 'disallow') && value && path.startsWith(value)) {
      if (value.length > matchedLength || (value.length === matchedLength && directive === 'allow')) {
        matchedLength = value.length;
        allowed = directive === 'allow';
      }
    }
  }
  return allowed;
}

async function pageSpeedScores(url: string) {
  const query = new URLSearchParams({ url, strategy: 'mobile', category: 'performance', key: env.PAGESPEED_API_KEY });
  query.append('category', 'seo');
  query.append('category', 'accessibility');
  // Count every request attempt: Google's quota counts requests, not successful audits.
  await recordPageSpeedCall();
  const response = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${query}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`PageSpeed Insights returned HTTP ${response.status}`);
  const result = await response.json() as {
    lighthouseResult?: {
      categories?: Record<string, { score?: number } | undefined>;
      audits?: Record<string, {
        numericValue?: number;
        displayValue?: string;
        details?: { screenshot?: { data?: string } };
      } | undefined>;
    };
  };
  const categories = result.lighthouseResult?.categories;
  const values = [
    { key: 'mobile_performance', label: 'performance', value: categories?.performance?.score, threshold: 0.5 },
    { key: 'seo', label: 'SEO', value: categories?.seo?.score, threshold: 0.7 },
    { key: 'accessibility', label: 'accessibility', value: categories?.accessibility?.score, threshold: 0.7 },
  ];
  if (values.some((item) => typeof item.value !== 'number')) throw new Error('PageSpeed response did not contain all requested category scores');
  const screenshotData = result.lighthouseResult?.audits?.['full-page-screenshot']?.details?.screenshot?.data;
  let thumbnail: Buffer | null = null;
  if (screenshotData) {
    const base64 = screenshotData.replace(/^data:image\/[^;]+;base64,/, '');
    const source = Buffer.from(base64, 'base64');
    if (source.length > 0 && source.length < 5_000_000) {
      for (const [width, quality] of [[240, 35], [180, 25], [120, 15]]) {
        const converted = await sharp(source).resize({ width, height: 160, fit: 'inside' }).webp({ quality }).toBuffer();
        if (converted.length <= 8_192) {
          thumbnail = converted;
          break;
        }
      }
    }
  }
  const lcp = result.lighthouseResult?.audits?.['largest-contentful-paint'];
  return {
    scores: values.map((item) => ({ ...item, value: Math.round(item.value! * 100) })),
    lcpMs: typeof lcp?.numericValue === 'number' ? Math.round(lcp.numericValue) : null,
    lcpDisplay: lcp?.displayValue ?? null,
    thumbnail,
  };
}

async function addContactIfAllowed(businessId: number, email: string, sourceUrl: string) {
  const normalized = normalizeContactEmail(email);
  if (!normalized || isDisposableEmail(normalized)) return;
  const business = await prisma.business.findUnique({ where: { id: businessId }, select: { country: true } });
  if (!business || isPersonalEmail(normalized, business.country)) return;
  const [suppressed, duplicate] = await Promise.all([
    prisma.suppression.findUnique({ where: { email: normalized }, select: { email: true } }),
    prisma.contact.findFirst({ where: { email: normalized }, select: { id: true } }),
  ]);
  if (suppressed || duplicate) return;
  await prisma.contact.create({ data: { businessId, email: normalized, sourceUrl } });
}

async function queryOverpass(query: string) {
  const failures: string[] = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        body: new URLSearchParams({ data: query }),
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'user-agent': 'EmailAutomator/1.0 (Overpass lead discovery)',
        },
        // Matches the 90 s server-side [timeout] plus transfer time.
        signal: AbortSignal.timeout(100000),
      });
      const body = await response.text();
      if (!response.ok) {
        const excerpt = body.replace(/\s+/g, ' ').trim().slice(0, 300);
        throw new Error(`HTTP ${response.status} ${response.statusText}${excerpt ? `: ${excerpt}` : ''}`);
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        throw new Error(`Invalid JSON response: ${body.replace(/\s+/g, ' ').trim().slice(0, 300) || '(empty body)'}`);
      }
      if (!payload || typeof payload !== 'object') {
        throw new Error('Response was not a JSON object');
      }
      const data = payload as { elements?: unknown; remark?: unknown };
      if (typeof data.remark === 'string' && data.remark.trim()) {
        throw new Error(`Overpass reported: ${data.remark.slice(0, 300)}`);
      }
      if (!Array.isArray(data.elements)) {
        throw new Error('JSON response did not contain an elements array');
      }
      return {
        endpoint,
        elements: data.elements.map((value): OverpassElement => {
          if (!value || typeof value !== 'object') return {};
          const element = value as Record<string, unknown>;
          const tags = element.tags && typeof element.tags === 'object'
            ? Object.fromEntries(
                Object.entries(element.tags).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
              )
            : undefined;
          const center = element.center && typeof element.center === 'object'
            ? element.center as Record<string, unknown>
            : null;
          const latitude = Number(element.lat);
          const longitude = Number(element.lon);
          const centerLatitude = Number(center?.lat);
          const centerLongitude = Number(center?.lon);
          return {
            type: typeof element.type === 'string' ? element.type : undefined,
            id: typeof element.id === 'string' || typeof element.id === 'number' ? element.id : undefined,
            tags,
            center: Number.isFinite(centerLatitude) && Number.isFinite(centerLongitude)
              ? { lat: centerLatitude, lon: centerLongitude }
              : undefined,
            latitude: Number.isFinite(latitude) ? latitude : undefined,
            longitude: Number.isFinite(longitude) ? longitude : undefined,
          };
        }),
      };
    } catch (error) {
      // undici reports network failures as a bare "fetch failed"; the cause carries the real reason (ECONNRESET, ENETUNREACH, ...).
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
      const detail = cause ? ` (${(cause as NodeJS.ErrnoException).code ?? cause.message})` : '';
      failures.push(`${new URL(endpoint).host}: ${errorMessage(error)}${detail}`);
    }
  }
  throw new Error(`All ${OVERPASS_ENDPOINTS.length} Overpass endpoints failed. ${failures.join(' | ')}`);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function auditAndDraft() {
  const now = new Date();
  const eligibleLedger = await prisma.contactLedger.findMany({
    where: { status: 'cooldown', eligibleAfter: { lte: now }, businessId: { not: null } },
    select: { businessId: true },
  });
  const recontactIds = eligibleLedger.flatMap((row) => row.businessId === null ? [] : [row.businessId]);
  const businesses = await prisma.business.findMany({
    where: {
      OR: [
        { status: 'new' },
        { id: { in: recontactIds }, status: 'contacted' },
      ],
    },
    orderBy: [{ score: 'desc' }, { id: 'asc' }],
    take: 40,
  });
  // Allocation bandit + re-contact policy (sequence limit, minimum probability, learned gamma) live in brain.ts.
  const selected = await chooseCandidates(businesses, 3);
  activity('audit', selected.length
    ? `Picked ${selected.length} of ${businesses.length} waiting ${businesses.length === 1 ? 'business' : 'businesses'} to research: ${selected.map((item) => item.business.name ?? 'unnamed').join(', ')}`
    : 'No businesses waiting for research');
  for (const candidate of selected) {
    const b = candidate.business;
    const label = b.name ?? `business #${b.id}`;
    try {
      activity('audit', `Researching ${label}${b.city ? ` in ${b.city}` : ''} (${b.track === 'site' ? 'has a website' : 'no website listed'})`);
      const findings: string[] = [];
      const signals: Array<{ key: string; evidence: string; sourceUrl?: string }> = [];
      let screenshot: Buffer | null = null;
      let score = 40;
      if (b.country === 'GB' && b.name && env.COMPANIES_HOUSE_API_KEY?.trim()) {
        try {
          activity('audit', `Checking Companies House for ${label}`);
          const registryMatch = await lookupCompaniesHouse(b.name, env.COMPANIES_HOUSE_API_KEY);
          if (registryMatch) {
            const details = [
              registryMatch.companyStatus ? `status ${registryMatch.companyStatus}` : null,
              registryMatch.companyType ? `type ${registryMatch.companyType}` : null,
              registryMatch.sicCodes.length ? `SIC ${registryMatch.sicCodes.join(', ')}` : null,
            ].filter((detail): detail is string => detail !== null);
            signals.push({
              key: 'registry_company_match',
              evidence: `Exact-name Companies House match ${registryMatch.companyNumber}${details.length ? ` (${details.join('; ')})` : ''}.`,
              sourceUrl: registryMatch.sourceUrl,
            });
          }
        } catch (error) {
          console.error(JSON.stringify({
            level: 'error',
            event: 'companies_house_lookup_failed',
            businessId: b.id,
            message: errorMessage(error),
          }));
        }
      }
      let contact = await prisma.contact.findFirst({
        where: { businessId: b.id },
        orderBy: { email: 'asc' },
        select: { id: true, email: true },
      });
      if (
        contact?.email &&
        (isPersonalEmail(contact.email, b.country) || isDisposableEmail(contact.email) || !await hasMailExchange(contact.email))
      ) contact = null;
      if (b.track === 'no_site') {
        const osmSourceUrl = b.osmId ? `https://www.openstreetmap.org/${b.osmId}` : undefined;
        findings.push('no_website_listing');
        signals.push({
          key: 'website_listing',
          evidence: "No business website URL is linked from the OpenStreetMap business listing",
          sourceUrl: osmSourceUrl,
        });
        score += 15;
        if (b.socialOnly) {
          findings.push('social_only');
          signals.push({ key: 'social_only', evidence: 'The only linked URL is a recognized social-media profile', sourceUrl: osmSourceUrl });
          score += 10;
        }
        const tags = (b.osmTags && typeof b.osmTags === 'object' && !Array.isArray(b.osmTags) ? b.osmTags : {}) as Record<string, unknown>;
        if (b.phone) {
          findings.push('phone_no_booking');
          signals.push({
            key: 'phone_no_booking',
            evidence: 'A phone number is present in the public listing, and no booking or ordering link is listed',
            sourceUrl: osmSourceUrl,
          });
          score += 5;
        }
        if (tags.opening_hours) {
          signals.push({ key: 'operating_evidence', evidence: 'Opening hours are listed in OpenStreetMap', sourceUrl: osmSourceUrl });
          score += 5;
        }
        if (!contact?.email || !await hasMailExchange(contact.email)) {
          await prisma.business.update({
            where: { id: b.id },
            data: {
              status: b.phone ? 'call_queue' : 'skipped',
              findings,
              score: Math.max(0, Math.min(100, score)),
              scoreSignals: signals,
              auditedAt: new Date(),
              callScript: b.phone
                ? `Hi, I found ${b.name} in ${b.city}'s public business listings. Is the person who handles your website or online bookings available?`
                : undefined,
            },
          });
          console.info(JSON.stringify({ level: 'info', event: 'no_site_lead_without_email', businessId: b.id, hasPhone: Boolean(b.phone) }));
          activity('audit', b.phone ? `${label} has no public email; added to the manual call queue` : `${label} has no public email or phone; skipped`, 'warn');
          continue;
        }
      } else {
        if (!b.websiteUrl) {
          await prisma.business.update({ where: { id: b.id }, data: { status: 'skipped' } });
          continue;
        }
        const startUrl = normalizeWebsite(b.websiteUrl);
        activity('audit', `Checking robots.txt on ${new URL(startUrl).hostname}`);
        if (!await robotsAllows(startUrl, new URL(startUrl).pathname)) {
          activity('audit', `${new URL(startUrl).hostname} asks crawlers not to visit; skipped ${label}`, 'warn');
          await prisma.business.update({
            where: { id: b.id },
            data: { status: 'skipped', findings: ['robots_disallow'], auditedAt: new Date() },
          });
          console.info(JSON.stringify({ level: 'info', event: 'website_audit_robots_disallow', businessId: b.id, url: startUrl }));
          continue;
        }
        activity('audit', `Loading the homepage of ${new URL(startUrl).hostname}`);
        const home = await fetchPublicPage(startUrl);
        if (
          new URL(home.url).origin !== new URL(startUrl).origin ||
          new URL(home.url).pathname !== new URL(startUrl).pathname
        ) {
          if (!await robotsAllows(home.url, new URL(home.url).pathname)) {
            await prisma.business.update({
              where: { id: b.id },
              data: { status: 'skipped', findings: ['robots_disallow'], auditedAt: new Date() },
            });
            continue;
          }
        }
        const contentType = home.response.headers.get('content-type') ?? '';
        if (!contentType.toLowerCase().includes('text/html')) {
          await prisma.business.update({
            where: { id: b.id },
            data: { status: 'skipped', findings: ['not_html'], auditedAt: new Date() },
          });
          continue;
        }
        const htmlPages = [{ url: home.url, $: load(await limitedText(home.response, 1_000_000, { truncate: true })) }];
        const homePage = htmlPages[0]!;
        const hostname = new URL(home.url).hostname;
        const contactLinks = homePage.$('a[href]').toArray()
          .map((element) => homePage.$(element).attr('href'))
          .filter((href): href is string => Boolean(href))
          .filter((href) => /contact|about|team/i.test(href))
          .slice(0, 3);
        if (contactLinks.length) activity('audit', `Reading ${contactLinks.length} contact/about ${contactLinks.length === 1 ? 'page' : 'pages'} on ${hostname}`);
        for (const href of contactLinks) {
          try {
            const url = new URL(href, home.url);
            if (url.hostname !== hostname || !['http:', 'https:'].includes(url.protocol)) continue;
            if (!await robotsAllows(home.url, url.pathname)) continue;
            const page = await fetchPublicPage(url.toString());
            if (new URL(page.url).hostname.toLowerCase() !== hostname.toLowerCase()) continue;
            if (new URL(page.url).pathname !== url.pathname && !await robotsAllows(home.url, new URL(page.url).pathname)) continue;
            if (!(page.response.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) continue;
            htmlPages.push({ url: page.url, $: load(await limitedText(page.response, 500_000, { truncate: true })) });
          } catch (error) {
            console.info(JSON.stringify({ level: 'info', event: 'contact_page_skipped', businessId: b.id, url: href, message: errorMessage(error) }));
          }
        }
        const $ = homePage.$;
        const secure = new URL(home.url).protocol === 'https:';
        if (!secure) {
          findings.push('no_https');
          signals.push({ key: 'no_https', evidence: `Homepage resolved to ${home.url}`, sourceUrl: home.url });
          score += 10;
        }
        if (!$('meta[name="viewport"]').length) {
          findings.push('not_mobile_friendly');
          signals.push({ key: 'viewport', evidence: 'The homepage HTML does not include a viewport meta tag', sourceUrl: home.url });
          score += 10;
        }
        if (!$('meta[name="description"]').length) {
          findings.push('missing_meta');
          signals.push({ key: 'meta_description', evidence: 'The homepage HTML does not include a meta description', sourceUrl: home.url });
          score += 5;
        }
        const copyrightYears = [...$.root().text().matchAll(/(?:©|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)]
          .map((match) => Number(match[1]))
          .filter(Number.isFinite);
        const currentYear = new Date().getFullYear();
        if (copyrightYears.some((year) => year < currentYear - 3)) {
          findings.push('old_copyright');
          signals.push({ key: 'copyright_year', evidence: `Observed copyright year(s): ${copyrightYears.join(', ')}`, sourceUrl: home.url });
          score += 5;
        }
        const hasBooking = htmlPages.some(({ $: page }) =>
          page('a[href],button').toArray().some((element) =>
            /book|reserv|order|schedule/i.test(`${page(element).text() ?? ''} ${page(element).attr('href') ?? ''}`),
          ),
        );
        if (!hasBooking) {
          findings.push('no_booking_link');
          signals.push({ key: 'booking_link', evidence: 'No homepage or contact-page link or button labeled with booking, reservations, ordering, or scheduling terms was found', sourceUrl: home.url });
          score += 5;
        }
        const hasContactForm = htmlPages.some(({ $: page }) =>
          page('form').toArray().some((element) => /contact|enquir|message/i.test(
            `${page(element).attr('action') ?? ''} ${page(element).text() ?? ''}`,
          )),
        );
        signals.push({
          key: 'contact_form',
          evidence: hasContactForm ? 'A contact-oriented form is present on the homepage or a contact page' : 'No contact-oriented form was detected on the homepage or contact pages',
          sourceUrl: home.url,
        });
        const generator = $('meta[name="generator"]').attr('content') ?? '';
        const platform = /wordpress|wix|squarespace|shopify|webflow|weebly/i.exec(generator)?.[0]
          ?? /wp-content|wixstatic|squarespace|cdn\.shopify|webflow\.com/i.exec($.html())?.[0];
        if (platform) signals.push({ key: 'platform', evidence: `Homepage HTML indicates ${platform}`, sourceUrl: home.url });
        activity('audit', `Site checks on ${hostname}: ${findings.length ? findings.map((item) => item.replaceAll('_', ' ')).join(', ') : 'no basic issues found'}`);
        const foundEmails = new Map<string, string>();
        for (const page of htmlPages) {
          const mailto = page.$('a[href^="mailto:"]').toArray()
            .map((element) => page.$(element).attr('href')?.slice(7).split(/[?;]/, 1)[0] ?? '');
          const textEmails = page.$.root().text().match(EMAIL) ?? [];
          for (const email of [...mailto, ...textEmails]) {
            const normalized = normalizeContactEmail(email);
            if (normalized) foundEmails.set(normalized, page.url);
          }
        }
        const candidates = [...foundEmails.entries()].sort(([a], [b]) =>
          Number(!/^(info|contact|hello|office|enquir|sales|booking|support)[+._-]?@/i.test(a))
          - Number(!/^(info|contact|hello|office|enquir|sales|booking|support)[+._-]?@/i.test(b)),
        );
        for (const [email, url] of candidates) {
          if (isPersonalEmail(email, b.country) || isDisposableEmail(email) || !await hasMailExchange(email)) continue;
          const [suppressed, duplicate] = await Promise.all([
            prisma.suppression.findUnique({ where: { email }, select: { email: true } }),
            prisma.contact.findFirst({ where: { email }, select: { id: true } }),
          ]);
          if (!suppressed && !duplicate) {
            const created = await prisma.contact.create({ data: { businessId: b.id, email, sourceUrl: url }, select: { id: true, email: true } });
            activity('audit', `Found a verified business email for ${label} (${email})`, 'success');
            contact = created;
            break;
          }
        }
        if (env.PAGESPEED_API_KEY && findings.length > 0) {
          try {
            activity('audit', `Running a Google PageSpeed mobile audit on ${hostname} (this takes 10-30 seconds)`);
            const pageSpeed = await pageSpeedScores(home.url);
            activity('audit', `PageSpeed for ${hostname}: ${pageSpeed.scores.map((item) => `${item.label} ${item.value}`).join(', ')}${pageSpeed.lcpDisplay ? `, load ${pageSpeed.lcpDisplay}` : ''}`);
            screenshot = pageSpeed.thumbnail;
            for (const item of pageSpeed.scores) {
              signals.push({ key: item.key, evidence: `Mobile PageSpeed ${item.label}: ${item.value}/100`, sourceUrl: home.url });
              if (item.value < item.threshold) {
                findings.push(item.key);
                score += item.key === 'mobile_performance' ? 15 : 5;
              } else {
                score -= 2;
              }
            }
            if (pageSpeed.lcpMs !== null) {
              signals.push({ key: 'largest_contentful_paint', evidence: `Mobile Largest Contentful Paint: ${pageSpeed.lcpDisplay ?? `${pageSpeed.lcpMs} ms`}`, sourceUrl: home.url });
              if (pageSpeed.lcpMs > 2500) {
                findings.push('slow_lcp');
                score += 5;
              }
            }
          } catch (error) {
            console.error(JSON.stringify({ level: 'error', event: 'pagespeed_failed', businessId: b.id, message: errorMessage(error) }));
            activity('audit', `PageSpeed audit failed for ${label}: ${errorMessage(error)}`, 'warn');
          }
        }
      }
      if (!contact?.email) {
        const noEmailStatus = b.track === 'no_site' && b.phone ? 'call_queue' : 'skipped';
        activity('audit', `No usable email found for ${label}; ${noEmailStatus === 'call_queue' ? 'added to the call queue' : 'skipped'}`, 'warn');
        await prisma.business.update({
          where: { id: b.id },
          data: { status: noEmailStatus, findings, score: Math.max(0, Math.min(100, score)), scoreSignals: signals, auditedAt: new Date() },
        });
        continue;
      }
      const [suppressed, ledger] = await Promise.all([
        prisma.suppression.findUnique({ where: { email: contact.email }, select: { email: true } }),
        prisma.contactLedger.findUnique({ where: { email: contact.email } }),
      ]);
      const cooldownActive = ledger?.status === 'cooldown' && ledger.eligibleAfter !== null && ledger.eligibleAfter > new Date();
      const permanentlyBlocked = ledger && !['eligible', 'cooldown'].includes(ledger.status);
      if (suppressed || cooldownActive || permanentlyBlocked) {
        activity('audit', `${label} skipped: ${suppressed ? 'address is on the do-not-contact list' : cooldownActive ? 'contacted recently (cooldown)' : 'contact is blocked'}`, 'warn');
        await prisma.business.update({
          where: { id: b.id },
          data: { status: 'cooldown', findings: [...findings, suppressed ? 'contact_suppressed' : 'contact_cooldown'], auditedAt: new Date() },
        });
        continue;
      }
      if (!findings.length) {
        activity('audit', `The website of ${label} looks healthy; nothing honest to pitch, so skipped`);
        await prisma.business.update({
          where: { id: b.id },
          data: { status: 'skipped', score: Math.max(0, Math.min(100, score)), scoreSignals: signals, auditedAt: new Date() },
        });
        continue;
      }
      const recent = await prisma.email.findMany({
        where: { status: { in: ['drafted', 'approved', 'sent'] }, body: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { subject: true, body: true },
      });
      const previousEmails = await prisma.email.findMany({
        where: { contactId: contact.id, status: { in: ['sent', 'rejected', 'failed'] } },
        orderBy: { createdAt: 'desc' },
        select: { draftAngle: true },
      });
      const usedAngles = previousEmails.flatMap((email) => email.draftAngle ? [email.draftAngle] : []);
      const angle = await chooseAngle(findings, usedAngles);
      const subjectStyle = await chooseSubjectStyle();
      const memory = await getDraftingMemory({ niche: b.niche, country: b.country, track: b.track });
      activity('draft', `Writing a draft for ${label} (angle: ${angle.replaceAll('_', ' ')}, ${subjectStyle} subject)`);
      const d = await draft(
        b,
        b.track === 'site' ? b.websiteUrl ?? '' : '',
        findings,
        recent,
        candidate.completedSequences,
        angle,
        usedAngles,
        { instructions: memory.instructions.map((item) => item.text), banned: memory.banned, style: subjectStyle },
      );
      await prisma.$transaction([
        prisma.email.create({
          data: {
          businessId: b.id,
          contactId: contact.id,
          subject: d.subject,
          origSubject: d.subject,
          body: d.body,
          origBody: d.body,
          manualRequired: d.manualRequired,
          draftAngle: angle,
          portfolioProject: d.portfolioName,
          draftConfidence: d.confidence,
          selectionInfo: {
            ...candidate.info,
            angle,
            subjectStyle,
            memoryIds: memory.instructions.map((item) => item.id),
          } as unknown as Prisma.InputJsonValue,
          },
        }),
        prisma.business.update({
          where: { id: b.id },
          data: {
          status: 'review',
          findings,
          score: Math.max(0, Math.min(100, score)),
          scoreSignals: signals,
          auditedAt: new Date(),
          screenshot: screenshot ? Uint8Array.from(screenshot) : null,
          screenshotExpiresAt: screenshot ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
          },
        }),
        ...(ledger ? [prisma.contactLedger.update({
          where: { email: contact.email },
          data: { status: 'in_review', blockReason: null },
        })] : []),
      ]);
      activity('draft', d.manualRequired
        ? `Draft for ${label} needs manual writing: the suggestion failed a quality check`
        : `Draft ready for your review: ${label}`, d.manualRequired ? 'warn' : 'success');
    } catch (error) {
      await prisma.business.update({
        where: { id: b.id },
        data: { status: 'skipped', findings: ['audit_error'], auditedAt: new Date() },
      });
      console.error(JSON.stringify({ level: 'error', event: 'business_audit_failed', businessId: b.id, message: errorMessage(error) }));
      activity('audit', `Research failed for ${label}: ${errorMessage(error)}`, 'error');
    }
  }
}

function isValidDraft(
  value: { subject: string; body: string },
  businessName: string,
  facts: string[],
  allowedUrls: string[],
) {
  const subject = value.subject.trim();
  const body = value.body.trim();
  const words = body.split(/\s+/).filter(Boolean);
  const urls = (body.match(/https?:\/\/\S+/gi) ?? []).map((url) => url.replace(/[),.!?]+$/, ''));
  const bodyWithoutUrls = body.replace(/https?:\/\/\S+/gi, '');
  const allowedNumbers = new Set(`${facts.join(' ')} ${businessName}`.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? []);
  const numericClaims = bodyWithoutUrls.match(/\b\d+(?:[.,]\d+)?%?\b/g) ?? [];
  return subject.length >= 8 && subject.length <= 100 && subject.split(/\s+/).length <= 12 &&
    !/[\r\n]/.test(subject) && words.length >= 80 && words.length <= 120 &&
    body.toLowerCase().includes(businessName.toLowerCase()) && !/[<>]/.test(body) &&
    !/\b(guaranteed|100%|act now|limited time|risk[- ]free)\b/i.test(`${subject} ${body}`) &&
    numericClaims.every((claim) => allowedNumbers.has(claim)) &&
    urls.length <= 1 && urls.every((url) => allowedUrls.includes(url)) &&
    facts.some((fact) => body.toLowerCase().includes(fact.toLowerCase()));
}

function wordShingles(text: string) {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const shingles = new Set<string>();
  for (let i = 0; i < words.length - 1; i++) shingles.add(`${words[i]} ${words[i + 1]}`);
  return shingles;
}

function isNearDuplicate(text: string, previous: Array<{ subject: string | null; body: string | null }>) {
  const candidate = wordShingles(text);
  if (!candidate.size) return false;
  return previous.some(({ subject, body }) => {
    const prior = wordShingles(`${subject ?? ''} ${body ?? ''}`);
    if (!prior.size) return false;
    let intersection = 0;
    for (const token of candidate) if (prior.has(token)) intersection++;
    return intersection / (candidate.size + prior.size - intersection) >= 0.72;
  });
}

async function draft(
  b: { name: string | null; city: string | null; track: string },
  _url: string,
  findings: string[],
  recent: Array<{ subject: string | null; body: string | null }>,
  previousContactCount: number,
  angle: string,
  previousAngles: string[],
  brain: { instructions: string[]; banned: string[]; style: SubjectStyle } = { instructions: [], banned: [], style: 'plain' },
) {
  const facts = findings.map((x) => LABEL[x]).filter((fact): fact is string => Boolean(fact));
  const noSite = b.track === 'no_site';
  const portfolio = portfolioMatch(b.name ?? '', b.track, facts);
  const allowedUrls = portfolio ? [portfolio.url] : [];
  const fallback = {
    subject: noSite ? `A simple online presence for ${b.name}` : `Quick note about ${b.name}'s website`,
    body: noSite
      ? `Hi,\n\n${facts.join('; and ')}. I help small businesses get a simple website and online booking presence set up. Would it be useful if I sent a short outline?\n\n${env.SENDER_NAME}`
      : `Hi,\n\nI was looking at ${b.name}'s website and noticed that ${facts.join('; and ')}. I'm a freelance web developer and could help improve this. Would it be useful if I sent a short outline?\n\n${env.SENDER_NAME}`,
  };
  let selected = fallback;
  let manualRequired = true;
  let confidence: number | null = null;
  let previousAttempt = '';
  if (env.LLM_API_KEY && TOKEN_BUDGET > 0) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const request = {
        model: env.LLM_MODEL,
        response_format: { type: 'json_object' },
        max_completion_tokens: 350,
        temperature: 0.4,
        messages: [
          {
            role: 'system',
            content: 'Write a polite, plain-text business outreach email of 80-120 words. Use ONLY the verified facts given; make no unsupported claims or numbers. Never say a business has no website; say only that no website was linked from its public listing. One specific observation, one practical improvement, one low-pressure question. No hype, pressure, flattery, fake familiarity, or invented links. Include at most the supplied portfolio proof URL. For recontacts, use the requested angle and do not repeat prior angle. Follow the requested subjectStyle. If a playbook list of owner preferences is supplied, follow it only where it does not conflict with these rules. Return JSON with exactly subject (string), body (string), finding_ids_used (array of supplied finding ids), and confidence (number 0..1).',
          },
          {
            role: 'user',
            content: JSON.stringify({
              business: b.name,
              city: b.city,
              track: noSite ? 'no-site' : 'site',
              offer: noSite ? 'starter website and online booking presence' : 'website improvements',
              findings: findings.map((id) => ({ id, evidence: LABEL[id] })),
              sender: env.SENDER_NAME,
              recontact: previousContactCount > 0,
              angle,
              subjectStyle: brain.style,
              subjectStyleHint: STYLE_HINTS[brain.style],
              playbook: brain.instructions.length ? brain.instructions : undefined,
              previousAngles: previousContactCount > 0 ? previousAngles : [],
              portfolio: portfolio ?? undefined,
              previousDraft: attempt ? previousAttempt : undefined,
            }),
          },
        ],
      };
      const estimate = Math.ceil(JSON.stringify(request).length / 3) + 350;
      const utcDay = new Date();
      utcDay.setUTCHours(0, 0, 0, 0);
      await prisma.dailyTokenUsage.upsert({
        where: { day: utcDay },
        create: { day: utcDay, totalTokens: 0 },
        update: {},
      });
      const reserved = await prisma.dailyTokenUsage.updateMany({
        where: { day: utcDay, totalTokens: { lte: TOKEN_BUDGET - estimate } },
        data: { totalTokens: { increment: estimate } },
      });
      if (!reserved.count) {
        console.info(JSON.stringify({ level: 'info', event: 'llm_token_budget_exhausted', budget: TOKEN_BUDGET }));
        break;
      }
      let actualTokens: number | null = null;
      let validCandidate: { subject: string; body: string; confidence: number } | null = null;
      try {
        const baseUrl = (env.LLM_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${env.LLM_API_KEY}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(30000),
          body: JSON.stringify(request),
        });
        if (!response.ok) throw new Error(`LLM request failed with HTTP ${response.status}`);
        const payload: unknown = await response.json();
        if (!payload || typeof payload !== 'object') throw new Error('LLM response was not an object');
        const data = payload as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { total_tokens?: unknown };
        };
        // Count the tokens the provider actually billed even if the draft below fails validation.
        actualTokens = typeof data.usage?.total_tokens === 'number' && Number.isSafeInteger(data.usage.total_tokens)
          ? data.usage.total_tokens
          : estimate;
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('LLM response did not include message content');
        const generated: unknown = JSON.parse(content);
        if (!generated || typeof generated !== 'object' || Array.isArray(generated)) throw new Error('LLM draft was not a JSON object');
        previousAttempt = content;
        const candidate = generated as {
          subject?: unknown;
          body?: unknown;
          finding_ids_used?: unknown;
          confidence?: unknown;
        };
        const responseKeys = Object.keys(generated);
        if (responseKeys.length !== 4 ||
            !['subject', 'body', 'finding_ids_used', 'confidence'].every((key) => responseKeys.includes(key)) ||
            typeof candidate.subject !== 'string' || typeof candidate.body !== 'string' ||
            !Array.isArray(candidate.finding_ids_used) || candidate.finding_ids_used.length === 0 ||
            !candidate.finding_ids_used.every((id) => typeof id === 'string' && findings.includes(id)) ||
            typeof candidate.confidence !== 'number' || !Number.isFinite(candidate.confidence) ||
            candidate.confidence < 0 || candidate.confidence > 1 ||
            !isValidDraft({ subject: candidate.subject, body: candidate.body }, b.name ?? '', facts, allowedUrls) ||
            containsBannedPhrase(`${candidate.subject} ${candidate.body}`, brain.banned) !== null ||
            !candidate.finding_ids_used.every((id) => {
              const fact = LABEL[id as string];
              return Boolean(fact && typeof candidate.body === 'string' &&
                candidate.body.toLowerCase().includes(fact.toLowerCase()));
            })) {
          throw new Error('LLM draft failed response or content validation');
        }
        const candidateText = `${candidate.subject.trim()} ${candidate.body.trim()}`;
        if (isNearDuplicate(candidateText, recent)) throw new Error('LLM draft is too similar to recent outreach');
        validCandidate = {
          subject: candidate.subject.trim(),
          body: candidate.body.trim(),
          confidence: candidate.confidence,
        };
      } catch (error) {
        console.error(JSON.stringify({
          level: 'error',
          event: 'llm_draft_attempt_failed',
          attempt: attempt + 1,
          message: errorMessage(error),
        }));
      }
      await prisma.dailyTokenUsage.update({
        where: { day: utcDay },
        data: { totalTokens: { increment: (actualTokens ?? 0) - estimate } },
      });
      if (validCandidate) {
        selected = { subject: validCandidate.subject, body: validCandidate.body };
        confidence = validCandidate.confidence;
        manualRequired = false;
        break;
      }
    }
  }
  if (manualRequired) {
    if (portfolio && !noSite) {
      selected.body = `${selected.body}\n\nA relevant example of my work: ${portfolio.url}`;
    }
    console.info(JSON.stringify({ level: 'info', event: 'draft_requires_manual_writing' }));
  }
  return { ...selected, manualRequired, confidence, portfolioName: portfolio?.name ?? null };
}

type PortfolioProject = { name: string; summary: string; niche: string; url: string };

function portfolioProjects(): PortfolioProject[] {
  const raw = env.PORTFOLIO_PROJECTS?.trim();
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) throw new Error('PORTFOLIO_PROJECTS must be a JSON array');
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const project = item as Record<string, unknown>;
      if (typeof project.name !== 'string' || typeof project.summary !== 'string' ||
          typeof project.niche !== 'string' || typeof project.url !== 'string') return [];
      const url = new URL(project.url);
      if (url.protocol !== 'https:') return [];
      return [{ name: project.name.slice(0, 100), summary: project.summary.slice(0, 500), niche: project.niche.slice(0, 120), url: url.toString() }];
    });
  } catch (error) {
    console.error(JSON.stringify({ level: 'error', event: 'portfolio_configuration_invalid', message: errorMessage(error) }));
    return [];
  }
}

function portfolioMatch(name: string, track: string, facts: string[]): PortfolioProject | null {
  const projects = portfolioProjects();
  if (!projects.length) return null;
  const target = new Set(`${name} ${track} ${facts.join(' ')}`.toLowerCase().match(/[a-z]{3,}/g) ?? []);
  return projects
    .map((project) => {
      const terms = new Set(`${project.niche} ${project.summary}`.toLowerCase().match(/[a-z]{3,}/g) ?? []);
      let overlap = 0;
      for (const term of terms) if (target.has(term)) overlap++;
      return { project, score: terms.size ? overlap / terms.size : 0 };
    })
    .filter((match) => match.score >= 0.12)
    .sort((a, b) => b.score - a.score)[0]?.project ?? null;
}

async function sendDue() {
  const now = new Date();
  if (!DRY && (
    !env.POSTAL_ADDRESS?.trim() ||
    /your business postal address/i.test(env.POSTAL_ADDRESS) ||
    !env.APP_ORIGIN?.startsWith('https://')
  )) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'live_send_blocked',
      message: 'Live sending requires a real POSTAL_ADDRESS and HTTPS APP_ORIGIN.',
    }));
    activity('send', 'Live sending is blocked: set a real POSTAL_ADDRESS and an HTTPS APP_ORIGIN', 'error');
    return;
  }
  await prisma.email.updateMany({
    where: { status: 'held', holdUntil: { lte: now }, manualRequired: false },
    data: { status: 'approved', holdUntil: null },
  });
  const n = await prisma.email.count({
    where: { status: 'sent', sentAt: { gt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
  });
  const cap = await getEffectiveDailyCap(now);
  if (n >= cap) {
    activity('send', `Daily limit reached (${n} of ${cap} sent in the last 24 hours); waiting`);
    return;
  }
  const enabledMarkets = await prisma.market.findMany({ where: { enabled: true }, select: { code: true } });
  if (!enabledMarkets.length) {
    activity('send', 'No markets are enabled, so nothing can be sent', 'warn');
    return;
  }
  const email = await prisma.email.findFirst({
    where: {
      status: 'approved',
      scheduledFor: { lte: now },
      manualRequired: false,
      sendPlanItems: {
        some: {
          sendPlan: {
            is: {
              state: 'announced',
              announcedAt: { lte: new Date(now.getTime() - SEND_PLAN_MIN_NOTICE_MS) },
              startsAt: { lte: now },
              endsAt: { gte: now },
            },
          },
        },
      },
      contact: { is: { email: { not: null } } },
      business: { is: { country: { in: enabledMarkets.map((market) => market.code) } } },
    },
    include: { contact: true, business: true },
    orderBy: { scheduledFor: 'asc' },
  });
  if (!email?.contact?.email) {
    const approved = await prisma.email.count({ where: { status: 'approved' } });
    activity('send', approved
      ? `${approved} approved ${approved === 1 ? 'email is' : 'emails are'} waiting for an active Send Plan window`
      : 'Nothing approved to send right now');
    return;
  }
  const to = email.contact.email;
  const recipient = email.business?.name ?? to;
  const isFollowUp = email.sequenceStep > 0 && Boolean(email.gmailThreadId);
  if (isFollowUp && await prisma.replyRecord.findFirst({
    where: { threadId: email.gmailThreadId!, classification: { in: ['human', 'auto_reply', 'unsubscribe', 'complaint', 'bounce'] } },
    select: { id: true },
  })) {
    await prisma.email.update({ where: { id: email.id }, data: { status: 'rejected', error: 'reply_received_before_follow_up' } });
    activity('send', `Cancelled follow-up to ${recipient}: they already replied`);
    return;
  }
  if (await prisma.suppression.findUnique({ where: { email: to }, select: { email: true } })) {
    await prisma.email.update({ where: { id: email.id }, data: { status: 'rejected', error: 'suppressed' } });
    activity('send', `Cancelled email to ${recipient}: address unsubscribed or bounced`, 'warn');
    return;
  }
  const ledger = await prisma.contactLedger.findUnique({ where: { email: to } });
  if (ledger && (!['eligible', 'in_review', 'cooldown'].includes(ledger.status) ||
      (!isFollowUp && ledger.eligibleAfter && ledger.eligibleAfter > now))) {
    await prisma.email.update({ where: { id: email.id }, data: { status: 'rejected', error: 'contact_ledger_block' } });
    activity('send', `Cancelled email to ${recipient}: contact policy blocks it`, 'warn');
    return;
  }
  const domain = email.business?.websiteUrl
    ? new URL(email.business.websiteUrl).hostname.toLowerCase().replace(/^www\./, '')
    : `business-${email.businessId ?? email.id}`;
  const domainLock = await prisma.domainLock.findUnique({ where: { domain } });
  if (!isFollowUp && domainLock && domainLock.lockedUntil > now) {
    const nextWindow = nextRecipientWindow(domainLock.lockedUntil, email.business?.timezone || 'UTC');
    await prisma.email.update({
      where: { id: email.id },
      data: { scheduledFor: nextWindow, error: 'domain_lock_deferred' },
    });
    activity('send', `Postponed ${recipient}: this domain was emailed recently; moved to ${nextWindow.toISOString()}`);
    return;
  }
  const claimed = await prisma.email.updateMany({
    where: {
      id: email.id,
      status: 'approved',
      scheduledFor: { lte: now },
      sendPlanItems: {
        some: {
          sendPlan: {
            is: {
              state: 'announced',
              announcedAt: { lte: new Date(now.getTime() - SEND_PLAN_MIN_NOTICE_MS) },
              startsAt: { lte: now },
              endsAt: { gte: now },
            },
          },
        },
      },
    },
    data: { status: 'sending' },
  });
  if (!claimed.count) return;
  try {
    if (!DRY && (!env.POSTAL_ADDRESS?.trim() || /your business postal address/i.test(env.POSTAL_ADDRESS))) {
      throw new Error('POSTAL_ADDRESS must contain a real postal address before live sending');
    }
    const unsubscribe = DRY
      ? 'https://dry-run.invalid/api/unsubscribe'
      : await unsubscribeUrl(to);
    const portfolioFooter = portfolioEmailFooter(await getPortfolioSettings(), email.body ?? '');
    const body = `${email.body}${portfolioFooter}\n\n--\n${env.SENDER_NAME}, ${env.POSTAL_ADDRESS}\nTo stop receiving these emails, unsubscribe here: ${unsubscribe}`;
    const messageId = `<${randomUUID()}@${new URL(env.APP_ORIGIN || 'http://localhost:3000').hostname}>`;
    const previousMessage = isFollowUp
      ? await prisma.email.findFirst({
        where: { gmailThreadId: email.gmailThreadId, status: 'sent', rfcMessageId: { not: null } },
        orderBy: { sentAt: 'desc' },
        select: { rfcMessageId: true },
      })
      : null;
    activity('send', `${DRY ? 'Simulating send' : 'Sending'} ${isFollowUp ? `follow-up #${email.sequenceStep}` : 'email'} to ${recipient} <${to}>`);
    const sentMessage = DRY
      ? { id: 'dry-run', threadId: `dry-run-${email.gmailThreadId ?? email.id}`, messageId }
      : await gmailSend(to, email.subject ?? '', body, unsubscribe, messageId, email.gmailThreadId ?? undefined, previousMessage?.rfcMessageId ?? undefined);
    const sentAt = new Date();
    const eligibleAfter = new Date(sentAt.getTime() + RECONTACT_DAYS * 24 * 60 * 60 * 1000);
    await prisma.$transaction([
      prisma.email.update({
        where: { id: email.id },
        data: {
          status: 'sent',
          sentAt,
          gmailMessageId: sentMessage.id,
          gmailThreadId: sentMessage.threadId,
          rfcMessageId: sentMessage.messageId,
          followUpDueAt: email.sequenceStep === 0
            ? new Date(sentAt.getTime() + 4 * 24 * 60 * 60 * 1000)
            : email.sequenceStep === 1
              ? new Date(sentAt.getTime() + 5 * 24 * 60 * 60 * 1000)
              : null,
          error: null,
        },
      }),
      prisma.contactLedger.upsert({
        where: { email: to },
        create: {
          email: to,
          domain,
          businessId: email.businessId,
          status: 'cooldown',
          firstContactAt: sentAt,
          lastContactAt: sentAt,
          eligibleAfter,
          contactCount: 1,
        },
        update: {
          domain,
          businessId: email.businessId,
          status: 'cooldown',
          lastContactAt: sentAt,
          eligibleAfter,
          contactCount: { increment: 1 },
        },
      }),
      prisma.domainLock.upsert({
        where: { domain },
        create: {
          domain,
          businessId: email.businessId,
          lastSentAt: sentAt,
          lockedUntil: eligibleAfter,
        },
        update: {
          businessId: email.businessId,
          lastSentAt: sentAt,
          lockedUntil: eligibleAfter,
        },
      }),
      ...(email.businessId !== null ? [
        prisma.business.update({ where: { id: email.businessId }, data: { status: 'contacted' } }),
      ] : []),
      prisma.sendPlan.updateMany({
        where: { state: 'announced', items: { every: { email: { is: { status: 'sent' } } } } },
        data: { state: 'completed' },
      }),
    ]);
    activity('send', `${DRY ? 'Dry run: recorded as sent' : 'Sent'} to ${recipient}`, 'success');
  } catch (err) {
    await prisma.email.update({
      where: { id: email.id },
      data: { status: 'failed', error: errorMessage(err).slice(0, 300) },
    });
    activity('send', `Sending to ${recipient} failed: ${errorMessage(err)}`, 'error');
  }
}

async function gmailSend(
  to: string,
  subject: string,
  body: string,
  unsubscribe: string,
  messageId: string,
  threadId?: string,
  inReplyTo?: string,
) {
  const accessToken = await gmailAccessToken();
  const senderName = (env.SENDER_NAME || '').replace(/[\r\n<>"]/g, '').trim();
  const raw = [
    `From: ${senderName ? `${senderName} <${env.OWNER_EMAIL}>` : env.OWNER_EMAIL}`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject.replace(/[\r\n]/g, ' ')).toString('base64')}?=`,
    `Message-ID: ${messageId}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    `List-Unsubscribe: <${unsubscribe}>, <mailto:${env.OWNER_EMAIL}?subject=unsubscribe>`,
    'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ].join('\r\n');
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: new Headers({ authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }),
    body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url'), ...(threadId ? { threadId } : {}) }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`Gmail send failed with HTTP ${response.status}`);
  const sent = await response.json() as { id?: unknown; threadId?: unknown };
  if (typeof sent.id !== 'string' || typeof sent.threadId !== 'string') {
    throw new Error('Gmail send response did not include message and thread IDs');
  }
  return { id: sent.id, threadId: sent.threadId, messageId };
}
