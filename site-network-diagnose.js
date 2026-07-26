const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE_URL = process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site/';
const TARGET_CODE = process.env.ETF_CODE || '449450';
const TARGET_NAME = process.env.ETF_NAME || 'PLUS K방산';
const TARGET_DATE = process.env.ETF_DATE || '20260724';
const SKIP_ENRICH = process.env.SKIP_ENRICH === '1';
const VERIFY_EXPECT_NONZERO = process.env.VERIFY_EXPECT_NONZERO === '1';
const STATE_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const ENRICHMENT_RESULT_PATH = path.join(__dirname, 'diagnostics', 'enrichment-result.json');

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

function enrichLocalState(currentMarket) {
  const result = {
    capturedAt: new Date().toISOString(),
    targetCode: TARGET_CODE,
    status: 'running',
  };

  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    const item = state.items?.[TARGET_CODE];
    if (!item) throw new Error(`ETF 배치 항목이 없습니다: ${TARGET_CODE}`);

    const marketDate = String(currentMarket.meta?.asOf || '').replaceAll('-', '');
    const itemDate = String(item.etf?.date || state.meta?.date || '');
    if (!marketDate) throw new Error('시장 데이터 기준일이 없습니다.');
    if (marketDate !== itemDate) {
      throw new Error(`기준일 불일치: 시장=${marketDate}, PDF=${itemDate}`);
    }

    let pricedComponents = 0;
    let totalContribution = 0;
    item.components = item.components.map((component) => {
      const live = currentMarket.stocks?.[component.code];
      const stockReturn = Number.isFinite(live?.returnRate) ? live.returnRate : null;
      const contribution = stockReturn === null
        ? null
        : round(Number(component.weight || 0) * stockReturn / 100);
      if (stockReturn !== null) {
        pricedComponents += 1;
        totalContribution += contribution;
      }
      return {
        ...component,
        stockReturn,
        contribution,
        marketDataDate: marketDate,
        marketDataSource: currentMarket.meta?.source || 'krx-api-live',
      };
    });

    totalContribution = round(totalContribution);
    item.summary = {
      ...item.summary,
      totalContribution,
      pricedComponents,
      marketDataDate: marketDate,
      marketDataSource: currentMarket.meta?.source || 'krx-api-live',
    };
    item.enrichedAt = new Date().toISOString();
    state.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);

    Object.assign(result, {
      status: 'completed',
      date: marketDate,
      componentCount: item.components.length,
      pricedComponents,
      totalContribution,
      sample: item.components.slice(0, 5).map((component) => ({
        code: component.code,
        name: component.name,
        weight: component.weight,
        stockReturn: component.stockReturn,
        contribution: component.contribution,
      })),
    });
  } catch (error) {
    Object.assign(result, { status: 'failed', error: error.message });
  }

  fs.writeFileSync(ENRICHMENT_RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  if (result.status !== 'completed') throw new Error(result.error);
  return result;
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

    const base = new URL(SITE_URL);
    const directPaths = {
      currentMarketData: '/api/market-data',
      previousMarketData: `/api/market-data?date=${TARGET_DATE}&previous=1`,
      batchData: `/api/batch-data?code=${TARGET_CODE}&date=${TARGET_DATE}`,
      history: `/api/etf-history?code=${TARGET_CODE}&period=1M&date=${TARGET_DATE}`,
      etfList: '/etfs.json',
    };
    const direct = {};
    for (const [name, pathname] of Object.entries(directPaths)) {
      const url = new URL(pathname, base).toString();
      direct[name] = await safeGet(context.request, url);
    }

    const currentMarket = direct.currentMarketData.json || {};
    const previousMarket = direct.previousMarketData.json || {};
    const batch = direct.batchData.json || {};
    const history = direct.history.json || {};
    const etfList = direct.etfList.json || [];
    const targetEtf = currentMarket.etfs?.[TARGET_CODE] || null;
    const previousTargetEtf = previousMarket.etfs?.[TARGET_CODE] || null;
    const componentCodes = (batch.components || []).map((item) => item.code).filter(Boolean);
    const componentSample = componentCodes.slice(0, 20).map((code) => ({
      code,
      marketData: currentMarket.stocks?.[code] || null,
      batchComponent: (batch.components || []).find((item) => item.code === code) || null,
    }));
    const historyPoints = Array.isArray(history.points) ? history.points : [];
    const batchNonZeroCount = (batch.components || []).filter((component) => (
      Number(component.stockReturn) !== 0 || Number(component.contribution) !== 0
    )).length;
    const capturedAt = new Date().toISOString();
    const enrichment = SKIP_ENRICH ? null : enrichLocalState(currentMarket);
    const apiSummary = {
      capturedAt,
      targetCode: TARGET_CODE,
      targetDate: TARGET_DATE,
      currentMarketData: {
        ...statusOnly(direct.currentMarketData),
        meta: currentMarket.meta || null,
        etfCount: currentMarket.etfs ? Object.keys(currentMarket.etfs).length : 0,
        stockCount: currentMarket.stocks ? Object.keys(currentMarket.stocks).length : 0,
        targetEtf,
      },
      previousMarketData: {
        ...statusOnly(direct.previousMarketData),
        meta: previousMarket.meta || null,
        targetEtf: previousTargetEtf,
      },
      batchData: {
        ...statusOnly(direct.batchData),
        etf: batch.etf || null,
        summary: batch.summary || null,
        componentCount: componentCodes.length,
        nonZeroComponentCount: batchNonZeroCount,
      },
      history: {
        ...statusOnly(direct.history),
        pointCount: historyPoints.length,
        first: historyPoints[0] || null,
        last: historyPoints.at(-1) || null,
      },
      etfList: {
        ...statusOnly(direct.etfList),
        count: Array.isArray(etfList) ? etfList.length : 0,
      },
      enrichment,
      componentSample,
    };

    const bodyText = compact(await page.locator('body').innerText(), 60000);
    const localStorage = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage)));
    const sessionStorage = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
    const scripts = await page.locator('script[src]').evaluateAll((nodes) => nodes.map((node) => node.src));

    await page.screenshot({ path: 'diagnostics/site-449450.png', fullPage: true });
    fs.writeFileSync('diagnostics/site-body.txt', `${bodyText}\n`);
    fs.writeFileSync('diagnostics/site-network.json', JSON.stringify({
      capturedAt,
      siteUrl: SITE_URL,
      targetCode: TARGET_CODE,
      targetName: TARGET_NAME,
      targetDate: TARGET_DATE,
      finalUrl: page.url(),
      scripts,
      localStorage,
      sessionStorage,
      consoleMessages,
      events,
      apiSummary,
      bodyText,
    }, null, 2));
    fs.writeFileSync('diagnostics/site-api-summary.json', JSON.stringify(apiSummary, null, 2));

    console.log(`API 요약: ${JSON.stringify(apiSummary)}`);
    console.log(`화면 본문: ${bodyText.slice(0, 7000)}`);

    if (VERIFY_EXPECT_NONZERO && batchNonZeroCount === 0) {
      throw new Error('배포 /api/batch-data의 stockReturn과 contribution이 여전히 전부 0입니다.');
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
