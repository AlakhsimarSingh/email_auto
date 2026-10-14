import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePortfolioSettings, portfolioEmailFooter } from './portfolio.js';

test('validates and normalizes the portfolio and recent work links', () => {
  assert.deepEqual(parsePortfolioSettings({
    portfolioUrl: 'https://portfolio.example',
    latestWork: [{ title: 'Booking refresh', url: 'https://work.example/booking' }],
  }), {
    portfolioUrl: 'https://portfolio.example/',
    latestWork: [{ title: 'Booking refresh', url: 'https://work.example/booking' }],
  });
});

test('requires unique HTTPS links and limits recent work entries', () => {
  assert.throws(() => parsePortfolioSettings({
    portfolioUrl: 'http://portfolio.example',
    latestWork: [],
  }), /HTTPS/);
  assert.throws(() => parsePortfolioSettings({
    portfolioUrl: 'https://portfolio.example',
    latestWork: [{ title: 'Duplicate', url: 'https://portfolio.example' }],
  }), /unique/);
  assert.throws(() => parsePortfolioSettings({
    portfolioUrl: null,
    latestWork: Array.from({ length: 6 }, (_, index) => ({
      title: `Work ${index}`,
      url: `https://work.example/${index}`,
    })),
  }), /five/);
  assert.throws(() => parsePortfolioSettings({ portfolioUrl: null, latestWork: [] }), /at least one/);
});

test('formats all configured links and avoids repeating a link already in a draft', () => {
  const settings = parsePortfolioSettings({
    portfolioUrl: 'https://portfolio.example',
    latestWork: [{ title: 'Booking refresh', url: 'https://work.example/booking' }],
  });
  assert.equal(
    portfolioEmailFooter(settings),
    '\n\nSelected work:\nPortfolio: https://portfolio.example/\nRecent work — Booking refresh: https://work.example/booking',
  );
  assert.equal(
    portfolioEmailFooter(settings, 'Already shared https://work.example/booking'),
    '\n\nSelected work:\nPortfolio: https://portfolio.example/',
  );
});
