const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SITE_URL = (process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site').replace(/\/$/, '');
const TARGET_CODE = process.env.ETF_CODE || '449450';
const OUTPUT_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'enrichment-result.json');

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const result = {
    capturedAt: new Date().toISOString(),
    targetCode: TARGET_CODE,
    status: 'running',
  };

  try {
    const state = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
    const item = state.items?.[TARGET_CODE];
    if (!item) throw new Error(`ETF 배치 항목이 없습니다: ${TARGET_CODE}`);

    const response = await fetch(`${SITE_URL}/api/market-data`);
    if (!response.ok) throw new Error(`시장 데이터 API 실패 (${response.status})`);
    const market = await response.json();
    const marketDate = String(market.meta?.asOf || '').replaceAll('-', '');
    const itemDate = String(item.etf?.date || state.meta?.date || '');
    if (marketDate !== itemDate) {
      throw new Error(`기준일 불일치: 시장=${marketDate}, PDF=${itemDate}`);
    }

    let pricedComponents = 0;
    let totalContribution = 0;
    item.components = item.components.map((component) => {
      const live = market.stocks?.[component.code];
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
        marketDataSource: market.meta?.source || 'krx-api-live',
      };
    });

    totalContribution = round(totalContribution);
    item.summary = {
      ...item.summary,
      totalContribution,
      pricedComponents,
      marketDataDate: marketDate,
      marketDataSource: market.meta?.source || 'krx-api-live',
    };
    item.enrichedAt = new Date().toISOString();
    state.meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(state, null, 2)}\n`);

    Object.assign(result, {
      status: 'completed',
      date: marketDate,
      componentCount: item.components.length,
      pricedComponents,
      totalContribution,
      sample: item.components.slice(0, 5).map((component) => ({
        code: component.code,
        stockReturn: component.stockReturn,
        contribution: component.contribution,
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
