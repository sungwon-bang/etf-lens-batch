const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site').replace(/\/$/, '');
const TARGET_CODE = process.env.ETF_CODE || '449450';
const DATA_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'architecture-check.json');
const PREVIOUS_NETWORK_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'latest-network.json');

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
  try {
    const response = await fetch(url, {
      headers: {
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      },
      redirect: 'follow',
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      contentType: response.headers.get('content-type') || '',
      text,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      url,
      contentType: '',
      text: '',
      error: error.message,
    };
  }
}

async function fetchJson(url) {
  const result = await fetchText(url);
  let json = null;
  try {
    json = JSON.parse(result.text);
  } catch {}
  return { ...result, json };
}

function snippet(text, pattern, radius = 260) {
  pattern.lastIndex = 0;
  const match = pattern.exec(text);
  if (!match) return null;
  const start = Math.max(0, match.index - radius);
  const end = Math.min(text.length, match.index + match[0].length + radius);
  return text.slice(start, end);
}

function compact(text, limit = 1200) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function formatDate(value) {
  return String(value || '').replaceAll('-', '');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function addAssetUrl(target, value) {
  if (!value || !/\.js(?:$|\?)/i.test(value)) return;
  try {
    target.add(new URL(value, SITE_URL).toString());
  } catch {}
}

async function findBatchData(dateCandidates) {
  const attempts = [];
  for (const date of dateCandidates) {
    const url = `${SITE_URL}/api/batch-data?code=${TARGET_CODE}&date=${date}&architectureCheck=${Date.now()}`;
    const response = await fetchJson(url);
    const components = Array.isArray(response.json?.components) ? response.json.components : [];
    attempts.push({ date, status: response.status, componentCount: components.length, url: response.url });
    if (response.ok && components.length) return { response, date, attempts };
  }

  const noDateUrl = `${SITE_URL}/api/batch-data?code=${TARGET_CODE}&architectureCheck=${Date.now()}`;
  const noDateResponse = await fetchJson(noDateUrl);
  const noDateComponents = Array.isArray(noDateResponse.json?.components)
    ? noDateResponse.json.components
    : [];
  attempts.push({ date: null, status: noDateResponse.status, componentCount: noDateComponents.length, url: noDateResponse.url });
  if (noDateResponse.ok && noDateComponents.length) {
    return { response: noDateResponse, date: null, attempts };
  }

  return { response: noDateResponse, date: null, attempts };
}

async function main() {
  const capturedAt = new Date().toISOString();
  const state = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  const localItem = state.items?.[TARGET_CODE] || null;
  const localComponents = localItem?.components || [];

  const marketResponse = await fetchJson(`${SITE_URL}/api/market-data?architectureCheck=${Date.now()}`);
  const market = marketResponse.json || {};
  const marketDate = formatDate(market.meta?.asOf);
  const stateDate = formatDate(state.meta?.date);
  const itemDate = formatDate(localItem?.etf?.date);
  const dateCandidates = unique([itemDate, stateDate, marketDate, '20260724', '20260723']);

  const batchLookup = await findBatchData(dateCandidates);
  const batchResponse = batchLookup.response;
  const batch = batchResponse.json || {};
  const batchComponents = Array.isArray(batch.components) ? batch.components : [];

  const rootResponse = await fetchText(`${SITE_URL}/`);
  const assetUrls = new Set();
  const assetPattern = /(?:src|href)=["']([^"']+\.js(?:\?[^"']*)?)["']/gi;
  let assetMatch;
  while ((assetMatch = assetPattern.exec(rootResponse.text))) addAssetUrl(assetUrls, assetMatch[1]);

  if (fs.existsSync(PREVIOUS_NETWORK_PATH)) {
    const previousNetwork = fs.readFileSync(PREVIOUS_NETWORK_PATH, 'utf8');
    const absolutePattern = /https?:\/\/[^"'\s]+\.js(?:\?[^"'\s]*)?/gi;
    const relativePattern = /\/assets\/[^"'\s]+\.js(?:\?[^"'\s]*)?/gi;
    for (const value of previousNetwork.match(absolutePattern) || []) addAssetUrl(assetUrls, value);
    for (const value of previousNetwork.match(relativePattern) || []) addAssetUrl(assetUrls, value);
  }

  addAssetUrl(assetUrls, '/assets/page-C38lZqhW.js');

  const scriptResults = [];
  for (const url of assetUrls) {
    const response = await fetchText(url);
    scriptResults.push({
      url,
      status: response.status,
      contentType: response.contentType,
      text: response.ok ? response.text : '',
      error: response.error || null,
    });
  }
  const successfulScripts = scriptResults.filter((item) => item.status === 200 && item.text);
  const bundle = `${rootResponse.text}\n${successfulScripts.map((item) => item.text).join('\n')}`;

  const batchFirstPattern = /stockReturn\s*\?\?.{0,300}?returnRate/s;
  const liveFirstPattern = /returnRate\s*\?\?.{0,300}?stockReturn/s;
  const finiteLivePattern = /Number\.isFinite\([^)]*returnRate[^)]*\)/s;

  const localStockReturn = classify(localComponents, 'stockReturn');
  const localContribution = classify(localComponents, 'contribution');
  const batchStockReturn = classify(batchComponents, 'stockReturn');
  const batchContribution = classify(batchComponents, 'contribution');

  const localHasNoStoredValues = localItem
    ? localStockReturn.nonZero === 0
      && localStockReturn.zero === 0
      && localStockReturn.other === 0
      && localContribution.nonZero === 0
      && localContribution.zero === 0
      && localContribution.other === 0
    : null;

  const apiPreservesNullOrMissing = batchComponents.length
    ? batchStockReturn.zero === 0
      && batchContribution.zero === 0
      && batchStockReturn.nonZero === 0
      && batchContribution.nonZero === 0
    : null;

  const bundleUsesLiveFirst = successfulScripts.length
    ? liveFirstPattern.test(bundle) || finiteLivePattern.test(bundle)
    : null;
  const bundleUsesBatchFirst = successfulScripts.length
    ? batchFirstPattern.test(bundle)
    : null;
  const frontendConforms = successfulScripts.length
    ? bundleUsesLiveFirst && !bundleUsesBatchFirst
    : null;

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
      targetStocksAvailable: localComponents.filter(
        (item) => Number.isFinite(market.stocks?.[item.code]?.returnRate),
      ).length,
    },
    batchData: {
      requestedDate: batchLookup.date,
      attempts: batchLookup.attempts,
      status: batchResponse.status,
      etf: batch.etf || null,
      componentCount: batchComponents.length,
      stockReturnFields: batchStockReturn,
      contributionFields: batchContribution,
      preservesNullOrMissing: apiPreservesNullOrMissing,
      sample: batchComponents.slice(0, 5),
    },
    deployedBundle: {
      rootStatus: rootResponse.status,
      rootContentType: rootResponse.contentType,
      rootSnippet: compact(rootResponse.text),
      discoveredAssetCount: assetUrls.size,
      successfulScriptCount: successfulScripts.length,
      scripts: scriptResults.map(({ url, status, contentType, error }) => ({
        url,
        status,
        contentType,
        error,
      })),
      usesBatchFirst: bundleUsesBatchFirst,
      usesLiveFirst: bundleUsesLiveFirst,
      batchFirstSnippet: snippet(bundle, batchFirstPattern),
      liveFirstSnippet: snippet(bundle, liveFirstPattern) || snippet(bundle, finiteLivePattern),
    },
    verdict: {
      localPdfConforms: localHasNoStoredValues,
      batchApiConforms: apiPreservesNullOrMissing,
      frontendConforms,
      fullyConforms: localHasNoStoredValues === true
        && apiPreservesNullOrMissing === true
        && frontendConforms === true,
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
