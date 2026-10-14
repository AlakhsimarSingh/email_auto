import { prisma } from './db.js';

export type PortfolioSettings = {
  portfolioUrl: string | null;
  latestWork: Array<{ title: string; url: string }>;
};

const SETTING_KEY = 'portfolio_links';

export function parsePortfolioSettings(value: unknown): PortfolioSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Portfolio settings must be an object');
  }
  const input = value as Record<string, unknown>;
  const portfolioUrl = input.portfolioUrl === '' || input.portfolioUrl === null
    ? null
    : validatePortfolioUrl(input.portfolioUrl);
  if (!Array.isArray(input.latestWork) || input.latestWork.length > 5) {
    throw new Error('Add no more than five recent work links');
  }
  const latestWork = input.latestWork.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Each recent work entry needs a title and URL');
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.title !== 'string') throw new Error('Each recent work entry needs a title');
    const title = item.title.trim();
    if (!title || title.length > 120 || /[\r\n\u0000-\u001f]/.test(title)) {
      throw new Error('Work titles must be 1–120 characters without control characters');
    }
    return { title, url: validatePortfolioUrl(item.url) };
  });
  if (!portfolioUrl && !latestWork.length) {
    throw new Error('Add a portfolio URL or at least one recent work link');
  }
  const urls = [portfolioUrl, ...latestWork.map((work) => work.url)].filter((url): url is string => Boolean(url));
  if (new Set(urls).size !== urls.length) {
    throw new Error('Each portfolio and work link must be unique');
  }
  return { portfolioUrl, latestWork };
}

function validatePortfolioUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new Error('Portfolio links must be valid HTTPS URLs');
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Portfolio links must be valid HTTPS URLs');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('Portfolio links must use HTTPS and cannot contain embedded credentials');
  }
  return url.toString();
}

export async function getPortfolioSettings(): Promise<PortfolioSettings> {
  const setting = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY }, select: { value: true } });
  if (!setting) return { portfolioUrl: null, latestWork: [] };
  return parsePortfolioSettings(setting.value);
}

export function portfolioEmailFooter(settings: PortfolioSettings, existingBody = '') {
  const links = [
    ...(settings.portfolioUrl && !existingBody.includes(settings.portfolioUrl)
      ? [`Portfolio: ${settings.portfolioUrl}`]
      : []),
    ...settings.latestWork
      .filter((work) => !existingBody.includes(work.url))
      .map((work) => `Recent work — ${work.title}: ${work.url}`),
  ];
  return links.length ? `\n\nSelected work:\n${links.join('\n')}` : '';
}

export { SETTING_KEY as PORTFOLIO_SETTING_KEY };
