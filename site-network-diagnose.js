const { chromium } = require('playwright');
const fs = require('fs');

const SITE_URL = process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site/';
const TARGET_CODE = process.env.ETF_CODE || '449450';
const TARGET_NAME = process.env.ETF_NAME || 'PLUS K방산';

function compact(value, max = 2000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function main() {
  fs.mkdirSync('diagnostics', { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1600, height: 1200 },
  });
  const page = await context.newPage();
  const events = [];
  const consoleMessages = [];

  page.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: compact(message.text(), 4000) });
  });
  page.on('requestfailed', (request) => {
    events.push({
      kind: 'requestfailed',
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
      error: request.failure()?.errorText || '',
    });
  });
  page.on('response', async (response) => {
    const request = response.request();
    if (!['xhr', 'fetch', 'document', 'script'].includes(request.resourceType())) return;
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    let body = '';
    if (/json|text|javascript/.test(contentType)) {
      body = compact(await response.text().catch(() => ''), 20000);
    }
    events.push({
      kind: 'response',
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      url: response.url(),
      contentType,
      body,
    });
  });

  console.log(`사이트 접속: ${SITE_URL}`);
  await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForTimeout(8_000);

  const inputs = page.locator('input:visible');
  const inputCount = await inputs.count();
  let targetInput = null;
  for (let i = 0; i < inputCount; i += 1) {
    const candidate = inputs.nth(i);
    const placeholder = await candidate.getAttribute('placeholder').catch(() => '');
    const value = await candidate.inputValue().catch(() => '');
    if (/ETF|종목|검색/i.test(`${placeholder} ${value}`) || value.includes(TARGET_CODE) || value.includes(TARGET_NAME)) {
      targetInput = candidate;
      break;
    }
  }
  if (!targetInput && inputCount) targetInput = inputs.first();

  if (targetInput) {
    await targetInput.fill(TARGET_CODE).catch(async () => targetInput.fill(TARGET_NAME));
    const searchButton = page.getByRole('button', { name: /검색|조회/i }).first();
    if (await searchButton.isVisible().catch(() => false)) {
      await searchButton.click();
    } else {
      await targetInput.press('Enter').catch(() => {});
    }
    await page.waitForTimeout(15_000);
  }

  const bodyText = compact(await page.locator('body').innerText(), 60000);
  const localStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
  const sessionStorage = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  const scripts = await page.locator('script[src]').evaluateAll((nodes) => nodes.map((node) => node.src));

  await page.screenshot({ path: 'diagnostics/site-449450.png', fullPage: true });
  fs.writeFileSync('diagnostics/site-body.txt', `${bodyText}\n`);
  fs.writeFileSync('diagnostics/site-network.json', JSON.stringify({
    capturedAt: new Date().toISOString(),
    siteUrl: SITE_URL,
    targetCode: TARGET_CODE,
    targetName: TARGET_NAME,
    finalUrl: page.url(),
    scripts,
    localStorage,
    sessionStorage,
    consoleMessages,
    events,
    bodyText,
  }, null, 2));

  const apiEvents = events.filter((item) => item.kind === 'response' && ['xhr', 'fetch'].includes(item.resourceType));
  console.log(`XHR/fetch 응답 수: ${apiEvents.length}`);
  for (const item of apiEvents) {
    console.log(`[${item.status}] ${item.method} ${item.url}`);
    if (item.body) console.log(`응답: ${item.body.slice(0, 1500)}`);
  }
  console.log(`화면 본문: ${bodyText.slice(0, 7000)}`);
  await browser.close();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
