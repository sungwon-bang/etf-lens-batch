const fs = require('fs');
const path = require('path');
require('dotenv').config();

const SITE_URL = (process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site').replace(/\/$/, '');
const SITE_TOKEN = process.env.ETF_SITE_TOKEN || '';
const TARGET_CODE = process.env.ETF_CODE || '449450';
const RESULT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'repair-result.json');

function round(value, digits = 6) {
  return Number(Number(value).toFixed(digits));
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON 응답이 아닙니다 (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await readJson(response);
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${body.error || JSON.stringify(body).slice(0, 500)}`);
  }
  return body;
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

async function main() {
  const result = {
    capturedAt: new Date().toISOString(),
    targetCode: TARGET_CODE,
    siteUrl: SITE_URL,
    tokenConfigured: Boolean(SITE_TOKEN),
    status: 'running',
  };

  try {
    if (!SITE_TOKEN) {
      throw new Error('GitHub Secret ETF_SITE_TOKEN이 설정되지 않았습니다.');
    }

    const market = await fetchJson(`${SITE_URL}/api/market-data`);
    const asOf = String(market.meta?.asOf || '').replaceAll('-', '');
    if (!/^\d{8}$/.test(asOf)) throw new Error(`유효한 KRX 기준일이 없습니다: ${market.meta?.asOf}`);

    const batch = await fetchJson(`${SITE_URL}/api/batch-data?code=${TARGET_CODE}&date=${asOf}`);
    if (!Array.isArray(batch.components) || !batch.components.length) {
      throw new Error(`배치 구성종목이 없습니다: ${TARGET_CODE}/${asOf}`);
    }

    const components = batch.components.map((component) => {
      const live = market.stocks?.[component.code];
      const stockReturn = Number.isFinite(live?.returnRate) ? live.returnRate : null;
      const contribution = stockReturn === null ? null : round(component.weight * stockReturn / 100);
      return {
        code: component.code,
        name: live?.name || component.name,
        quantity: component.quantity || 0,
        evaluationAmount: component.evaluationAmount || 0,
        marketCap: component.marketCap || 0,
        weight: component.weight,
        stockReturn,
        contribution,
      };
    });

    const priced = components.filter((component) => component.stockReturn !== null);
    const totalContribution = round(priced.reduce((sum, component) => sum + component.contribution, 0));
    const payload = {
      etf: {
        code: batch.etf?.code || TARGET_CODE,
        name: batch.etf?.name || market.etfs?.[TARGET_CODE]?.name || '',
        date: asOf,
        parsingTime: new Date().toISOString(),
      },
      summary: {
        totalComponents: components.length,
        totalWeight: round(components.reduce((sum, component) => sum + Number(component.weight || 0), 0)),
        totalContribution,
        pricedComponents: priced.length,
        currency: 'KRW',
        marketDataSource: market.meta?.source || 'krx-api-live',
      },
      components,
    };

    const uploadResponse = await fetch(`${SITE_URL}/api/pdf`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'OAI-Sites-Authorization': `Bearer ${SITE_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const uploadText = await uploadResponse.text();
    let uploadBody;
    try { uploadBody = JSON.parse(uploadText); } catch { uploadBody = { raw: uploadText.slice(0, 1000) }; }
    if (!uploadResponse.ok) {
      throw new Error(`홈페이지 업로드 실패 (${uploadResponse.status}): ${JSON.stringify(uploadBody)}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
    const verified = await fetchJson(`${SITE_URL}/api/batch-data?code=${TARGET_CODE}&date=${asOf}&repair=${Date.now()}`);
    const verifiedComponents = Array.isArray(verified.components) ? verified.components : [];
    const nonZero = verifiedComponents.filter((component) => Number(component.stockReturn) !== 0);

    Object.assign(result, {
      status: nonZero.length ? 'completed' : 'uploaded_but_not_reflected',
      asOf,
      marketSource: market.meta?.source || null,
      stockApiComplete: market.meta?.stockApiComplete ?? null,
      componentCount: components.length,
      pricedComponents: priced.length,
      totalContribution,
      uploadStatus: uploadResponse.status,
      uploadBody,
      verifiedComponentCount: verifiedComponents.length,
      verifiedNonZeroReturns: nonZero.length,
      sample: verifiedComponents.slice(0, 5).map((component) => ({
        code: component.code,
        stockReturn: component.stockReturn,
        contribution: component.contribution,
      })),
    });

    writeResult(result);
    if (!nonZero.length) process.exitCode = 2;
  } catch (error) {
    Object.assign(result, { status: 'failed', error: error.message });
    writeResult(result);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode ||= 1;
});
