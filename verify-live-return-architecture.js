const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site').replace(/\/$/, '');
const TARGET_CODE = process.env.ETF_CODE || '449450';
const DATA_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'architecture-check.json');

function classify(items, field) {
  const result = { missing: 0, null: 0, zero: 0, nonZero: 0, other: 0 };
  for (const item of items || []) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) result.missing += 1;
    else if (item[field] === null) result.null += 1;
    else if (typeof item[field] === 'number' && item[field] === 0) result.zero += 1;
    else if (typeof item[field] === 'number' && Number.isFinite(item[field])) result.nonZero += 1;
    else result.other += 1;
  }
  return result;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'Cache-Control': 'no-cache' },
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, url: response.url, text };
}

async function fetchJson(url) {
  const result = await fetchText(url);
  let json = null;
  try {
    json = JSON.parse(result.text);
  } catch {}
  return { ...result, json };
}

function snippet(text, pattern, radius = 220) {
  const match = pattern.exec(text);
  if (!match) return null;
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return text.slice(start, end);
}

function formatDate(value) {
  return String(value || '').replaceAll('-', '');
}

async function main() {
  const capturedAt = new Date().toISOString();
  const state = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const localItem = state.items?.[TARGET_CODE] || null;
  const localComponents = localItem?.components || [];

  const marketResponse = await fetchJson(`${SITE_URL}/api/market-data?architectureCheck=${Date.now()}`);
  const market = marketResponse.json || {};
  const marketDate = formatDate(market.meta?.asOf);
  const localDate = formatDate(localItem?.etf?.date || state.meta?.date);
  const batchDate = marketDate || localDate;

  const batchResponse = batchDate
    ? await fetchJson(`${SITE_URL}/api/batch-data?code=${TARGET_CODE}&date=${batchDate}&architectureCheck=${Date.now()}`)
    : { ok: false, status: 0, url: null, text: '', json: null };
  const batch = batchResponse.json || {};
  const batchComponents = Array.isArray(batch.components) ? batch.components : [];

  const rootResponse = await fetchText(`${SITE_URL}/?architectureCheck=${Date.now()}`);
  const scriptUrls = [];
  const scriptPattern = /<script[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptPattern.exec(rootResponse.text))) {
    try {
      scriptUrls.push(new URL(scriptMatch[1], SITE_URL).toString());
    } catch {}
  }

  const scriptResults = [];
  for (const url of [...new Set(scriptUrls)]) {
    const response = await fetchText(url);
    scriptResults.push({ url, status: response.status, text: response.text });
  }
  const bundle = scriptResults.map((item) => item.text).join('\n');

  const batchFirstPattern = /stockReturn\s*\?\?[^;\n]{0,260}returnRate/;
  const liveFirstPattern = /returnRate\s*\?\?[^;\n]{0,260}stockReturn/;
  const finiteLivePattern = /Number\.isFinite\([^)]*returnRate[^)]*\)/;

  const localStockReturn = classify(localComponents, 'stockReturn');
  const localContribution = classify(localComponents, 'contribution');
  const batchStockReturn = classify(batchComponents, 'stockReturn');
  const batchContribution = classify(batchComponents, 'contribution');

  const localHasNoStoredValues = Boolean(localItem)
    && localStockReturn.nonZero === 0
    && localStockReturn.zero === 0
    && localStockReturn.other === 0
    && localContribution.nonZero === 0
    && localContribution.zero === 0
    && localContribution.other === 0;

  const apiPreservesNullOrMissing = batchComponents.length > 0
    && batchStockReturn.zero === 0
    && batchContribution.zero === 0
    && batchStockReturn.nonZero === 0
    && batchContribution.nonZero === 0;

  const bundleUsesLiveFirst = liveFirstPattern.test(bundle) || finiteLivePattern.test(bundle);
  const bundleUsesBatchFirst = batchFirstPattern.test(bundle);

  const result = {
    capturedAt,
    targetCode: TARGET_CODE,
    desiredArchitecture: {
      pdfJson: 'composition and weight only; stockReturn/contribution missing or null',
      batchApi: 'preserve missing or null; never coerce to zero',
      frontend: 'always prioritize /api/market-data stocks[code].returnRate',
    },
    collectionState: {
      date: state.meta?.date || null,
      total: state.meta?.total ?? null,
      completed: state.meta?.completed ?? null,
      failed: state.meta?.failed ?? null,
      status: state.meta?.status || null,
      updatedAt: state.meta?.updatedAt || null,
    },
    localPdfData: {
      itemExists: Boolean(localItem),
      date: localItem?.etf?.date || null,
      componentCount: localComponents.length,
      stockReturnFields: localStockReturn,
      contributionFields: localContribution,
      conforms: localHasNoStoredValues,
      sample: localComponents.slice(0, 5),
    },
    marketData: {
      status: marketResponse.status,
      source: market.meta?.source || null,
      asOf: market.meta?.asOf || null,
      stockApiComplete: market.meta?.stockApiComplete ?? null,
      targetEtf: market.etfs?.[TARGET_CODE] || null,
      targetStocksAvailable: localComponents.filter((item) => Number.isFinite(market.stocks?.[item.code]?.returnRate)).length,
    },
    batchData: {
      requestedDate: batchDate || null,
      status: batchResponse.status,
      etf: batch.etf || null,
      componentCount: batchComponents.length,
      stockReturnFields: batchStockReturn,
      contributionFields: batchContribution,
      preservesNullOrMissing: apiPreservesNullOrMissing,
      sample: batchComponents.slice(0, 5),
    },
    deployedBundle: {
      scriptCount: scriptResults.length,
      usesBatchFirst: bundleUsesBatchFirst,
      usesLiveFirst: bundleUsesLiveFirst,
      batchFirstSnippet: snippet(bundle, batchFirstPattern),
      liveFirstSnippet: snippet(bundle, liveFirstPattern) || snippet(bundle, finiteLivePattern),
    },
    verdict: {
      localPdfConforms: localHasNoStoredValues,
      batchApiConforms: apiPreservesNullOrMissing,
      frontendConforms: bundleUsesLiveFirst && !bundleUsesBatchFirst,
      fullyConforms: localHasNoStoredValues
        && apiPreservesNullOrMissing
        && bundleUsesLiveFirst
        && !bundleUsesBatchFirst,
      enrichmentPerformed: false,
    },
  };

  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify({
    capturedAt: new Date().toISOString(),
    targetCode: TARGET_CODE,
    status: 'failed',
    error: error.stack || error.message,
    enrichmentPerformed: false,
  }, null, 2)}\n`);
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
