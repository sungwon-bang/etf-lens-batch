const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TARGET_CODE = process.env.ETF_CODE || '449450';
const OUTPUT_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'enrichment-result.json');

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

function main() {
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
    const before = {
      stockReturnNonNull: 0,
      contributionNonNull: 0,
    };

    item.components = item.components.map((component) => {
      if (component.stockReturn !== null && component.stockReturn !== undefined) {
        before.stockReturnNonNull += 1;
      }
      if (component.contribution !== null && component.contribution !== undefined) {
        before.contributionNonNull += 1;
      }

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
      pricedComponents: null,
      contributionSource: 'live-market-data-only',
    };
    delete item.enrichedAt;
    state.meta.updatedAt = new Date().toISOString();

    const storedNonNullReturns = item.components.filter(
      (component) => component.stockReturn !== null,
    ).length;
    const storedNonNullContributions = item.components.filter(
      (component) => component.contribution !== null,
    ).length;

    if (storedNonNullReturns !== 0 || storedNonNullContributions !== 0) {
      throw new Error(
        `저장 수익률 정규화 실패: returns=${storedNonNullReturns}, contributions=${storedNonNullContributions}`,
      );
    }

    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(state, null, 2)}\n`);

    Object.assign(result, {
      status: 'completed',
      date: itemDate,
      componentCount: item.components.length,
      before,
      storedNonNullReturns,
      storedNonNullContributions,
      summaryTotalContribution: item.summary.totalContribution,
      summaryPricedComponents: item.summary.pricedComponents,
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

try {
  main();
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
