import type { load } from 'cheerio';
import { NICHE_PRESETS, presetForCategory } from './niches.js';

// What the business does and where it still works by hand. This drives the pitch: automation and
// features that save the owner time and money come first; website problems are a secondary mention.

type Page = { url: string; $: ReturnType<typeof load> };

/** Signs of manual work seen on the site. `seen` is what we may claim; feature/benefit is what we offer. */
export const OPPORTUNITY: Record<string, { seen: string; manual: string; feature: string; benefit: string }> = {
  opp_phone_booking: {
    seen: 'your site asks people to call to book',
    manual: 'taking bookings over the phone',
    feature: 'online booking that drops appointments straight into your calendar and sends automatic reminders',
    benefit: 'fewer calls to juggle, bookings coming in even after hours, and fewer no-shows',
  },
  opp_quote_by_phone: {
    seen: 'quotes are requested by phone or email',
    manual: 'collecting job details back and forth before you can quote',
    feature: 'a quote request form that collects the job details and photos up front and follows up automatically',
    benefit: 'less time on calls and more quotes turned into paid jobs',
  },
  opp_email_ordering: {
    seen: 'orders are placed by email or phone',
    manual: 'taking orders by hand',
    feature: 'simple online ordering with payment built in',
    benefit: 'orders arrive complete and paid, without the back-and-forth',
  },
  opp_pdf_menu: {
    seen: 'your menu or price list is a PDF',
    manual: 'editing and re-uploading PDFs whenever something changes',
    feature: 'a menu and price list you can edit yourself in seconds, easy to read on any phone',
    benefit: 'changes go live instantly and customers can actually read it on mobile',
  },
  opp_pdf_forms: {
    seen: 'your forms have to be downloaded and filled in by hand',
    manual: 'retyping paperwork',
    feature: 'online forms customers complete before they arrive, sent straight to you',
    benefit: 'no retyping and shorter waits at the front desk',
  },
  opp_no_contact_form: {
    seen: 'there is no enquiry form on your site',
    manual: 'answering the same questions one by one',
    feature: 'an enquiry form that sends you organised requests and replies to the customer instantly',
    benefit: 'no missed enquiries and faster replies, even when you are busy',
  },
  opp_no_online_store: {
    seen: 'your products are shown but cannot be bought online',
    manual: 'selling only in person or by message',
    feature: 'an online shop with click-and-collect',
    benefit: 'sales coming in around the clock, not only during opening hours',
  },
};

/** Specific automations per business type, used when the site gives no stronger clue. */
export const PLAYBOOK: Record<string, string[]> = {
  home_services: ['instant quote requests with photo upload', 'online job booking with automatic reminders', 'automatic review requests after each job'],
  automotive: ['online service booking', 'automatic service-due reminders', 'text updates when the car is ready'],
  beauty: ['online booking with deposits that cut no-shows', 'automatic appointment and rebooking reminders', 'gift cards and packages sold online'],
  wellness: ['online class and session booking', 'memberships and packages that renew automatically', 'automatic reminders and waitlists'],
  restaurants: ['online ordering and table reservations', 'a menu you can update in seconds', 'automatic review requests after visits'],
  cafes_bars: ['online ordering for pickup', 'event and private booking requests', 'a simple loyalty or newsletter signup'],
  lodging: ['direct booking that avoids booking-site commissions', 'automatic pre-arrival emails with check-in details', 'review requests after checkout'],
  dental: ['online appointment requests', 'automatic appointment and recall reminders', 'digital patient forms completed before the visit'],
  clinics: ['online appointment requests', 'automatic reminders that cut no-shows', 'digital intake forms completed before the visit'],
  pets: ['online grooming and appointment booking', 'automatic vaccination and visit reminders', 'reminder texts that cut no-shows'],
  professional: ['consultation booking straight into your calendar', 'online client intake forms', 'secure document upload instead of email attachments'],
  creative: ['an enquiry form that captures dates, budget and details up front', 'a live availability calendar', 'automatic quote follow-ups'],
  retail: ['an online shop with click-and-collect', 'stock that updates in one place', 'appointment booking for consultations or custom orders'],
  education: ['online class booking and payments', 'automatic lesson reminders', 'a simple signup form for new students'],
  default: ['online booking or enquiries straight into your calendar', 'automatic reminders and follow-ups', 'review requests after each customer visit'],
};

export type BusinessInsight = {
  summary: string | null;
  services: string[];
  opportunities: Array<{ key: string; evidence: string; sourceUrl: string }>;
  playbook: string[];
};

/** Business type preset from Overture category, OpenStreetMap tags, or the niche text. */
export function presetIdFor(niche: string | null, tags: unknown) {
  const record = tags && typeof tags === 'object' && !Array.isArray(tags) ? tags as Record<string, unknown> : {};
  const fromCategory = presetForCategory(typeof record.category === 'string' ? record.category : null);
  if (fromCategory) return fromCategory.id;
  for (const preset of NICHE_PRESETS) {
    const [key, value] = preset.osm.split('=');
    if (key && record[key] === value) return preset.id;
  }
  const text = (niche ?? '').toLowerCase();
  const keywords: Array<[string, RegExp]> = [
    ['dental', /dent|orthodont/], ['beauty', /salon|barber|hair|nail|beauty|spa|lash|brow/], ['wellness', /physio|chiro|massage|yoga|fitness|gym|pilates|wellness/],
    ['restaurants', /restaurant|eatery|pizza|grill|kitchen|diner|sushi|bistro/], ['cafes_bars', /cafe|coffee|bar|pub|brew|bakery/],
    ['home_services', /plumb|electric|roof|hvac|contract|landscap|garden|clean|paint|locksmith|renovat|construct|floor|pest/],
    ['automotive', /auto|car |mechanic|tire|tyre|body shop/], ['pets', /pet|vet|groom|dog/], ['professional', /law|attorney|account|tax|insur|real estate|mortgage|financ/],
    ['retail', /store|shop|boutique|jewel|florist|gift/], ['lodging', /hotel|inn|motel|b&b|bed and breakfast|lodg/], ['education', /tutor|school|class|lesson|academy/],
    ['clinics', /clinic|medical|doctor|optom|therap/], ['creative', /design|photo|print|event|studio|media/],
  ];
  return keywords.find(([, pattern]) => pattern.test(text))?.[0] ?? 'default';
}

const GENERIC_LINKS = /^(home|about( us)?|contact( us)?|blog|news|login|log in|sign in|sign up|register|cart|checkout|my account|account|search|menu|faq|faqs|privacy( policy)?|terms.*|careers|jobs|gallery|reviews|testimonials|book now|call now|more|read more|learn more|shop|locations?|directions|english|français|español)$/i;
const BOOKING_TOOLS = /calendly|acuityscheduling|squareup\.com\/appointments|square\.site|booksy|fresha|vagaro|mindbodyonline|setmore|simplybook|opentable|resy\.com|toasttab|janeapp|zocdoc|housecallpro|getjobber|schedulicity|glossgenius|tockify|exploretock|sevenrooms|yelp\.com\/reservations|booking\.com|checkfront/i;
const STORE_SIGNS = /cdn\.shopify|shopify\.com|woocommerce|add[-_ ]to[-_ ]cart|\/cart\b|ecwid|bigcommerce|squarespace-commerce|snipcart/i;

/** Visible page text with spaces between elements (cheerio's .text() glues neighbouring elements together). */
function visibleText($: Page['$']) {
  const parts: string[] = [];
  $('body').find('*').not('script, style, noscript, template, svg').contents().each((_, node) => {
    if (node.type === 'text' && node.data.trim()) parts.push(node.data.trim());
  });
  return parts.join(' ').replace(/\s+/g, ' ');
}

/** Strongest pitch first: manual booking, quoting and ordering beat PDFs and missing forms. */
const PRIORITY = ['opp_phone_booking', 'opp_quote_by_phone', 'opp_email_ordering', 'opp_pdf_forms', 'opp_no_online_store', 'opp_pdf_menu', 'opp_no_contact_form'];

function sentenceAround(text: string, index: number) {
  const start = Math.max(0, text.lastIndexOf('.', index) + 1, index - 120);
  const endDot = text.indexOf('.', index);
  const end = Math.min(text.length, endDot >= 0 ? endDot + 1 : index + 120, index + 160);
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 160);
}

/** Reads the homepage and contact/about pages for what the business does and where it works by hand. */
export function extractBusinessInsight(pages: Page[], niche: string | null, tags: unknown): BusinessInsight {
  const home = pages[0];
  const summary = home ? (() => {
    const $ = home.$;
    const meta = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
    const heading = $('h1').first().text();
    const paragraph = $('main p, p').filter((_, element) => $(element).text().trim().length > 60).first().text();
    const text = (meta.trim().length > 30 ? meta : `${heading}. ${paragraph}`).replace(/\s+/g, ' ').trim();
    return text.length > 20 ? text.slice(0, 300) : null;
  })() : null;

  const services: string[] = [];
  for (const page of pages.slice(0, 2)) {
    page.$('nav a, header a, h2, h3').each((_, element) => {
      const text = page.$(element).text().replace(/\s+/g, ' ').trim();
      if (text.length >= 3 && text.length <= 40 && !GENERIC_LINKS.test(text) && !/[@|©]|\d{3}/.test(text) && !services.some((item) => item.toLowerCase() === text.toLowerCase())) services.push(text);
    });
  }

  const html = pages.map((page) => page.$.html()).join('\n');
  const hasBookingTool = BOOKING_TOOLS.test(html);
  const hasStore = STORE_SIGNS.test(html);
  const hasForm = pages.some((page) => page.$('form').toArray().some((form) => page.$(form).find('input, textarea').length >= 2));
  const opportunities: BusinessInsight['opportunities'] = [];
  const add = (key: string, evidence: string, sourceUrl: string) => {
    if (!opportunities.some((item) => item.key === key)) opportunities.push({ key, evidence, sourceUrl });
  };
  for (const page of pages) {
    const text = visibleText(page.$);
    const checks: Array<[string, RegExp, boolean]> = [
      ['opp_phone_booking', /\b(call|phone|ring|text)\b[^.]{0,40}\b(to (book|schedule|reserve|make an appointment)|for (an )?appointments?|for reservations?)\b/i, !hasBookingTool],
      ['opp_quote_by_phone', /\b(call|email|contact us|text)\b[^.]{0,40}\b(free )?(quote|estimate)s?\b|\b(free )?(quote|estimate)s?\b[^.]{0,30}\b(call|email)\b/i, true],
      ['opp_email_ordering', /\b(email|call|message|dm)\b[^.]{0,40}\bto (place an )?order\b|\bto order,? (please )?(call|email)/i, !hasStore],
    ];
    for (const [key, pattern, applies] of checks) {
      const match = applies ? pattern.exec(text) : null;
      if (match) add(key, `The site says: "${sentenceAround(text, match.index)}"`, page.url);
    }
    page.$('a[href$=".pdf"], a[href*=".pdf?"]').each((_, element) => {
      const label = `${page.$(element).text()} ${page.$(element).attr('href') ?? ''}`.toLowerCase();
      if (/menu|price|rates|services/.test(label)) add('opp_pdf_menu', `The ${/menu/.test(label) ? 'menu' : 'price list'} is published as a PDF download`, page.url);
      if (/form|intake|registration|new patient|application|consent/.test(label)) add('opp_pdf_forms', 'Forms are offered as PDF downloads to print and fill in by hand', page.url);
    });
  }
  if (home && !hasForm) add('opp_no_contact_form', 'No enquiry or contact form was found on the homepage or contact pages', home.url);
  const presetId = presetIdFor(niche, tags);
  if (home && presetId === 'retail' && !hasStore) add('opp_no_online_store', 'No online shop or cart was found on the site', home.url);

  opportunities.sort((a, b) => PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key));
  return { summary, services: services.slice(0, 8), opportunities: opportunities.slice(0, 3), playbook: PLAYBOOK[presetId] ?? PLAYBOOK.default! };
}

/** Insight stored on the business (scoreSignals) so rewrites can reuse it without re-crawling. */
export function insightSignals(insight: BusinessInsight) {
  return [
    ...(insight.summary ? [{ key: 'site_summary', evidence: insight.summary }] : []),
    ...(insight.services.length ? [{ key: 'site_services', evidence: insight.services.join(', ') }] : []),
    ...insight.opportunities.map((item) => ({ key: item.key, evidence: item.evidence, sourceUrl: item.sourceUrl })),
  ];
}

export function insightFromSignals(signals: unknown, niche: string | null, tags: unknown): BusinessInsight | null {
  if (!Array.isArray(signals)) return null;
  const rows = signals.filter((row): row is { key: string; evidence: string; sourceUrl?: string } =>
    !!row && typeof row === 'object' && typeof (row as { key?: unknown }).key === 'string' && typeof (row as { evidence?: unknown }).evidence === 'string');
  if (!rows.some((row) => row.key === 'site_summary' || row.key === 'site_services' || row.key.startsWith('opp_'))) return null;
  return {
    summary: rows.find((row) => row.key === 'site_summary')?.evidence ?? null,
    services: rows.find((row) => row.key === 'site_services')?.evidence.split(', ').filter(Boolean) ?? [],
    opportunities: rows.filter((row) => row.key in OPPORTUNITY).map((row) => ({ key: row.key, evidence: row.evidence, sourceUrl: row.sourceUrl ?? '' })),
    playbook: PLAYBOOK[presetIdFor(niche, tags)] ?? PLAYBOOK.default!,
  };
}

export function emptyInsight(niche: string | null, tags: unknown): BusinessInsight {
  return { summary: null, services: [], opportunities: [], playbook: PLAYBOOK[presetIdFor(niche, tags)] ?? PLAYBOOK.default! };
}
