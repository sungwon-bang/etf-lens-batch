const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SITE_URL = (process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site').replace(/\/$/, '');
const TARGET_CODE = process.env.ETF_CODE || '449450';
const OUTPUT_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'enrichment-result.json');

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 1000) }; }
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(body)}`);
  return body;
}

async function main() {
  const result = {
    capturedAt: new Date().toISOString(),
    targetCode: TARGET_CODE,
    status: 'running',
    strategy: 'stored-return-null-live-market-fallback',
  };

  try {
    const state = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    const item = state.items?.[TARGET_CODE];
    if (!item) throw new Error(`ETF 배치 항목이 없습니다: ${TARGET_CODE}`);

    const itemDate = String(item.etf?.date || state.meta?.date || '');
    const market = await fetchJson(`${SITE_URL}/api/market-data`);
    const marketDate = String(market.meta?.asOf || '').replaceAll('-', '');
    if (marketDate !== itemDate) {
      throw new Error(`기준일 불일치: 시장=${marketDate}, PDF=${itemDate}`);
    }

    item.components = item.components.map((component) => {
      const normalized = { ...component };
      normalized.stockReturn = null;
      normalized.contribution = null;
      delete normalized.marketDataDate;
      delete normalized.marketDataSource;
      return normalized;
    });

    item.summary = {
      ...item.summary,
      totalContribution: null,
      pricedComponents: 0,
      contributionSource: 'live-market-data-only',
    };
    delete item.enrichedAt;
    state.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(state, null, 2)}\n`);

    Object.assign(result, {
      status: 'checkpoint_updated',
      date: itemDate,
      componentCount: item.components.length,
      storedNonNullReturns: item.components.filter((component) => component.stockReturn !== null).length,
      sampleBeforeApi: item.components.slice(0, 5).map((component) => ({
        code: component.code,
        stockReturn: component.stockReturn,
        contribution: component.contribution,
        liveReturnRate: market.stocks?.[component.code]?.returnRate ?? null,
      })),
    });
    writeResult(result);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    Object.assign(result, { status: 'failed', error: error.message });
    writeResult(result);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
