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

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`JSON 응답이 아닙니다 (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    throw new Error(`${response.status} ${url}: ${body.error || JSON.stringify(body).slice(0, 500)}`);
  }
  return { response, body };
}

function writeResult(result) {
  fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
  fs.writeFileSync(RESULT_PATH, `${JSON.stringify(result, null, 2)}\n`);
}

function cleanComponent(component) {
  return {
    code: String(component.code || '').trim(),
    name: String(component.name || '').trim(),
    quantity: Number(component.quantity || 0),
    evaluationAmount: Number(component.evaluationAmount || 0),
    marketCap: Number(component.marketCap || 0),
    weight: Number(component.weight || 0),
  };
}

function hasForbiddenFields(component) {
  return Object.prototype.hasOwnProperty.call(component, 'stockReturn')
    || Object.prototype.hasOwnProperty.call(component, 'contribution');
}

async function main() {
  const result = {
    capturedAt: new Date().toISOString(),
    targetCode: TARGET_CODE,
    siteUrl: SITE_URL,
    tokenConfigured: Boolean(SITE_TOKEN),
    status: 'running',
    policy: {
      pdfStoresReturns: false,
      batchDataShouldPreserveAbsence: true,
      frontendReturnSource: '/api/market-data stocks[code].returnRate',
    },
  };

  try {
    if (!SITE_TOKEN) throw new Error('GitHub Secret ETF_SITE_TOKEN이 설정되지 않았습니다.');

    const { body: batch } = await fetchJson(
      `${SITE_URL}/api/batch-data?code=${TARGET_CODE}&before=${Date.now()}`,
    );
    if (!Array.isArray(batch.components) || !batch.components.length) {
      throw new Error(`배치 구성종목이 없습니다: ${TARGET_CODE}`);
    }

    const components = batch.components.map(cleanComponent);
    const asOf = String(batch.etf?.date || batch.meta?.date || '').replaceAll('-', '');
    if (!/^\d{8}$/.test(asOf)) throw new Error(`유효한 PDF 기준일이 없습니다: ${asOf}`);

    const payload = {
      etf: {
        code: batch.etf?.code || TARGET_CODE,
        name: batch.etf?.name || '',
        date: asOf,
        parsingTime: new Date().toISOString(),
      },
      summary: {
        totalComponents: components.length,
        totalWeight: round(components.reduce((sum, component) => sum + component.weight, 0)),
        currency: 'KRW',
      },
      components,
    };

    if (payload.components.some(hasForbiddenFields)) {
      throw new Error('업로드 payload에 금지 필드가 포함됐습니다.');
    }

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

    await new Promise((resolve) => setTimeout(resolve, 5000));
    const { body: verified } = await fetchJson(
      `${SITE_URL}/api/batch-data?code=${TARGET_CODE}&date=${asOf}&after=${Date.now()}`,
    );
    const verifiedComponents = Array.isArray(verified.components) ? verified.components : [];
    const generatedReturnFields = verifiedComponents.filter(hasForbiddenFields);
    const zeroGenerated = generatedReturnFields.filter((component) => (
      component.stockReturn === 0 || component.contribution === 0
    ));

    Object.assign(result, {
      status: generatedReturnFields.length ? 'batch_api_reintroduced_fields' : 'completed',
      action: 'uploaded_composition_only',
      asOf,
      uploadStatus: uploadResponse.status,
      uploadBody,
      componentCount: components.length,
      uploadedForbiddenFieldCount: components.filter(hasForbiddenFields).length,
      verifiedComponentCount: verifiedComponents.length,
      batchGeneratedReturnFieldCount: generatedReturnFields.length,
      batchGeneratedZeroFieldCount: zeroGenerated.length,
      sample: verifiedComponents.slice(0, 7).map((component) => ({
        code: component.code,
        name: component.name,
        weight: component.weight,
        hasStockReturn: Object.prototype.hasOwnProperty.call(component, 'stockReturn'),
        stockReturn: component.stockReturn,
        hasContribution: Object.prototype.hasOwnProperty.call(component, 'contribution'),
        contribution: component.contribution,
      })),
    });
    writeResult(result);

    if (generatedReturnFields.length) {
      throw new Error(
        `/api/batch-data가 누락 필드를 다시 생성했습니다: ${generatedReturnFields.length}/${verifiedComponents.length}`,
      );
    }
  } catch (error) {
    if (result.status === 'running') result.status = 'failed';
    result.error = error.message;
    writeResult(result);
    throw error;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
