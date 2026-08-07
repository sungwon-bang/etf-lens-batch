const fs = require('fs');
const path = require('path');

// automation recheck: 2026-08-07 14:41 KST
const SITE_URL = (process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site').replace(/\/$/, '');
const TARGET_CODE = '449450';
const DATA_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'verify-449450-now.json');

function classify(items, field) {
  const out = { missing: 0, null: 0, zero: 0, nonZero: 0, other: 0 };
  for (const item of items || []) {
    if (!Object.prototype.hasOwnProperty.call(item, field)) out.missing += 1;
    else if (item[field] === null) out.null += 1;
    else if (item[field] === 0) out.zero += 1;
    else if (typeof item[field] === 'number' && Number.isFinite(item[field])) out.nonZero += 1;
    else out.other += 1;
  }
  return out;
}

async function fetchText(url) {
  try {
    const response = await fetch(url, {
      headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
      redirect: 'follow',
    });
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get('content-type') || '',
      text: await response.text(),
    };
  } catch (error) {
    return { ok: false, status: 0, url, contentType: '', text: '', error: error.message };
  }
}

async function fetchJson(url) {
  const result = await fetchText(url);
  let json = null;
  try { json = JSON.parse(result.text); } catch {}
  return { ...result, json };
}

function cleanDate(value) {
  return String(value || '').replaceAll('-', '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

async function main() {
  const state = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const item = state.items?.[TARGET_CODE] || null;
  const components = Array.isArray(item?.components) ? item.components : [];
  const stockReturnFields = classify(components, 'stockReturn');
  const contributionFields = classify(components, 'contribution');
  const localConforms = item ? (
    stockReturnFields.zero === 0
    && stockReturnFields.nonZero === 0
    && stockReturnFields.other === 0
    && contributionFields.zero === 0
    && contributionFields.nonZero === 0
    && contributionFields.other === 0
  ) : null;

  const marketResponse = await fetchJson(`${SITE_URL}/api/market-data?verify=${Date.now()}`);
  const market = marketResponse.json || {};
  const dateCandidates = unique([
    cleanDate(item?.etf?.date),
    cleanDate(state.meta?.date),
    cleanDate(market.meta?.asOf),
    '20260728',
    '20260727',
    '20260724',
  ]);

  const attempts = [];
  let batchResponse = null;
  let batchDate = null;
  for (const date of dateCandidates) {
    const response = await fetchJson(`${SITE_URL}/api/batch-data?code=${TARGET_CODE}&date=${date}&verify=${Date.now()}`);
    const count = Array.isArray(response.json?.components) ? response.json.components.length : 0;
    attempts.push({ date, status: response.status, componentCount: count, url: response.url });
    if (response.ok && count > 0) {
      batchResponse = response;
      batchDate = date;
      break;
    }
  }
  if (!batchResponse) {
    const response = await fetchJson(`${SITE_URL}/api/batch-data?code=${TARGET_CODE}&verify=${Date.now()}`);
    const count = Array.isArray(response.json?.components) ? response.json.components.length : 0;
    attempts.push({ date: null, status: response.status, componentCount: count, url: response.url });
    batchResponse = response;
  }

  const batch = batchResponse.json || {};
  const batchComponents = Array.isArray(batch.components) ? batch.components : [];
  const batchStockReturnFields = classify(batchComponents, 'stockReturn');
  const batchContributionFields = classify(batchComponents, 'contribution');
  const batchPreservesNullOrMissing = batchComponents.length ? (
    batchStockReturnFields.zero === 0
    && batchStockReturnFields.nonZero === 0
    && batchStockReturnFields.other === 0
    && batchContributionFields.zero === 0
    && batchContributionFields.nonZero === 0
    && batchContributionFields.other === 0
  ) : null;

  const root = await fetchText(`${SITE_URL}/?verify=${Date.now()}`);
  const assetUrls = new Set();
  const assetPattern = /(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/gi;
  let match;
  while ((match = assetPattern.exec(root.text))) {
    try { assetUrls.add(new URL(match[1], SITE_URL).toString()); } catch {}
  }
  assetUrls.add(`${SITE_URL}/assets/page-C38lZqhW.js`);

  const scripts = [];
  for (const url of assetUrls) {
    const response = await fetchText(url);
    scripts.push({ url, status: response.status, text: response.ok ? response.text : '' });
  }
  const bundle = scripts.map((script) => script.text).join('\n');
  const batchFirstPattern = /stockReturn\s*\?\?.{0,300}?returnRate/s;
  const liveFirstPattern = /returnRate\s*\?\?.{0,300}?stockReturn/s;
  const finiteLivePattern = /Number\.isFinite\([^)]*returnRate[^)]*\)/s;
  const usesBatchFirst = batchFirstPattern.test(bundle);
  const usesLiveFirst = liveFirstPattern.test(bundle) || finiteLivePattern.test(bundle);

  const result = {
    capturedAt: new Date().toISOString(),
    targetCode: TARGET_CODE,
    collectionState: state.meta,
    localPdfData: {
      itemExists: Boolean(item),
      date: item?.etf?.date || null,
      componentCount: components.length,
      stockReturnFields,
      contributionFields,
      conforms: localConforms,
      sample: components.slice(0, 3),
    },
    marketData: {
      status: marketResponse.status,
      source: market.meta?.source || null,
      asOf: market.meta?.asOf || null,
      stockApiComplete: market.meta?.stockApiComplete ?? null,
      targetEtf: market.etfs?.[TARGET_CODE] || null,
      targetStocksAvailable: components.filter((component) => Number.isFinite(market.stocks?.[component.code]?.returnRate)).length,
    },
    batchData: {
      requestedDate: batchDate,
      attempts,
      status: batchResponse.status,
      componentCount: batchComponents.length,
      stockReturnFields: batchStockReturnFields,
      contributionFields: batchContributionFields,
      preservesNullOrMissing: batchPreservesNullOrMissing,
      sample: batchComponents.slice(0, 3),
    },
    deployedBundle: {
      successfulScriptCount: scripts.filter((script) => script.status === 200).length,
      usesBatchFirst,
      usesLiveFirst,
    },
    verdict: {
      localPdfConforms: localConforms,
      batchApiConforms: batchPreservesNullOrMissing,
      frontendConforms: usesLiveFirst && !usesBatchFirst,
      fullyConforms: localConforms === true && batchPreservesNullOrMissing === true && usesLiveFirst && !usesBatchFirst,
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
