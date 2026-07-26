const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE_URL = process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site/';
const TARGET_CODE = process.env.ETF_CODE || '449450';
const TARGET_NAME = process.env.ETF_NAME || 'PLUS K방산';
const TARGET_DATE = process.env.ETF_DATE || '20260724';
const STATE_PATH = path.join(__dirname, 'data', 'etf-compositions.json');

function compact(value, max = 2000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

async function readJsonResponse(response) {
  const text = await response.text().catch(() => '');
  try {
    return { status: response.status(), url: response.url(), json: JSON.parse(text) };
  } catch {
    return { status: response.status(), url: response.url(), text: compact(text, 5000) };
  }
}

async function safeGet(request, url) {
  try {
    return await readJsonResponse(await request.get(url, { timeout: 120_000 }));
  } catch (error) {
    return { status: 0, url, error: error.message };
  }
}

function statusOnly(result) {
  return {
    status: result.status,
    url: result.url,
    error: result.error || null,
    text: result.text || null,
  };
}

function classifyField(components, field) {
  const counts = { missing: 0, null: 0, zero: 0, nonZero: 0, other: 0 };
  for (const component of components || []) {
    if (!Object.prototype.hasOwnProperty.call(component, field)) counts.missing += 1;
    else if (component[field] === null) counts.null += 1;
    else if (Number(component[field]) === 0) counts.zero += 1;
    else if (Number.isFinite(Number(component[field]))) counts.nonZero += 1;
    else counts.other += 1;
  }
  return counts;
}

function loadLocalPdfItem() {
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  const item = state.items?.[TARGET_CODE];
  if (!item) throw new Error(`ETF 배치 항목이 없습니다: ${TARGET_CODE}`);
  return { state, item };
}

async function main() {
  fs.mkdirSync('diagnostics', { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
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
      const contentType = response.headers()['content-type'] || '';
      let body = '';
      if (/json|text|javascript/.test(contentType)) {
        body = compact(await response.text().catch(() => ''), 30000);
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

    await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForTimeout(8_000);

    const input = page.locator('input[placeholder*="ETF"], input[aria-label*="ETF"], input:visible').first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill(TARGET_CODE).catch(async () => input.fill(TARGET_NAME));
      const button = page.getByRole('button', { name: /검색|조회/i }).first();
      if (await button.isVisible().catch(() => false)) await button.click();
      else await input.press('Enter').catch(() => {});
      await page.waitForTimeout(12_000);
    }

    const base = new URL(SITE_URL);
    const directPaths = {
      currentMarketData: '/api/market-data',
      batchData: `/api/batch-data?code=${TARGET_CODE}&date=${TARGET_DATE}&diagnose=${Date.now()}`,
      history: `/api/etf-history?code=${TARGET_CODE}&period=1M&date=${TARGET_DATE}`,
      etfList: '/etfs.json',
    };
    const direct = {};
    for (const [name, pathname] of Object.entries(directPaths)) {
      direct[name] = await safeGet(context.request, new URL(pathname, base).toString());
    }

    const { state, item: localItem } = loadLocalPdfItem();
    const market = direct.currentMarketData.json || {};
    const batch = direct.batchData.json || {};
    const localComponents = Array.isArray(localItem.components) ? localItem.components : [];
    const apiComponents = Array.isArray(batch.components) ? batch.components : [];

    const mergedSample = apiComponents.slice(0, 20).map((component) => {
      const live = market.stocks?.[component.code] || null;
      const liveReturnRate = Number.isFinite(live?.returnRate) ? live.returnRate : null;
      const contribution = liveReturnRate === null
        ? null
        : round(Number(component.weight || 0) * liveReturnRate / 100);
      return {
        code: component.code,
        name: live?.name || component.name,
        weight: component.weight,
        batchStockReturn: component.stockReturn,
        batchContribution: component.contribution,
        liveReturnRate,
        liveContribution: contribution,
      };
    });
    const liveContributionTotal = round(mergedSample.reduce(
      (sum, component) => sum + Number(component.liveContribution || 0),
      0,
    ));

    const scriptBodies = events
      .filter((event) => event.kind === 'response' && event.resourceType === 'script')
      .map((event) => event.body || '')
      .join('\n');
    const bundleHasBatchFirstExpression = /stockReturn\?\?[^\n]{0,120}returnRate/.test(scriptBodies);
    const bundleHasLiveFirstExpression = /returnRate\?\?[^\n]{0,120}stockReturn/.test(scriptBodies);

    const localStockReturn = classifyField(localComponents, 'stockReturn');
    const localContribution = classifyField(localComponents, 'contribution');
    const apiStockReturn = classifyField(apiComponents, 'stockReturn');
    const apiContribution = classifyField(apiComponents, 'contribution');
    const localHasStoredReturns = localStockReturn.zero + localStockReturn.nonZero > 0;
    const apiCoercesNullToZero = (
      localStockReturn.null > 0
      && apiStockReturn.zero > 0
      && apiStockReturn.null === 0
    );

    const bodyText = compact(await page.locator('body').innerText(), 60000);
    const capturedAt = new Date().toISOString();
    const apiSummary = {
      capturedAt,
      targetCode: TARGET_CODE,
      targetDate: TARGET_DATE,
      architecture: {
        desired: 'PDF JSON stores weights only; /api/market-data supplies live returns; browser calculates contributions',
        localHasStoredReturns,
        apiCoercesNullToZero,
        bundleHasBatchFirstExpression,
        bundleHasLiveFirstExpression,
        liveFallbackWorksWithCurrentApi: !apiCoercesNullToZero && bundleHasBatchFirstExpression,
      },
      localPdfData: {
        date: localItem.etf?.date || state.meta?.date || null,
        componentCount: localComponents.length,
        stockReturnFields: localStockReturn,
        contributionFields: localContribution,
      },
      currentMarketData: {
        ...statusOnly(direct.currentMarketData),
        meta: market.meta || null,
        targetEtf: market.etfs?.[TARGET_CODE] || null,
        stockCount: market.stocks ? Object.keys(market.stocks).length : 0,
      },
      batchData: {
        ...statusOnly(direct.batchData),
        etf: batch.etf || null,
        summary: batch.summary || null,
        componentCount: apiComponents.length,
        stockReturnFields: apiStockReturn,
        contributionFields: apiContribution,
      },
      liveCalculationSample: mergedSample,
      liveContributionTotalForSample: liveContributionTotal,
    };

    await page.screenshot({ path: 'diagnostics/site-449450.png', fullPage: true });
    fs.writeFileSync('diagnostics/site-body.txt', `${bodyText}\n`);
    fs.writeFileSync('diagnostics/site-api-summary.json', JSON.stringify(apiSummary, null, 2));
    fs.writeFileSync('diagnostics/site-network.json', JSON.stringify({
      capturedAt,
      siteUrl: SITE_URL,
      finalUrl: page.url(),
      consoleMessages,
      events,
      apiSummary,
      bodyText,
    }, null, 2));

    console.log(JSON.stringify(apiSummary, null, 2));
    if (localHasStoredReturns) {
      throw new Error('PDF JSON에 stockReturn 또는 contribution 숫자가 남아 있습니다.');
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
