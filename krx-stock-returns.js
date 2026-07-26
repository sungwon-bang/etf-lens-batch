const fs = require('fs');
const path = require('path');
require('dotenv').config();

const OUTPUT_PATH = path.join(__dirname, 'data', 'stock-returns.json');
const MAX_LOOKBACK_DAYS = 14;
const REQUEST_TIMEOUT_MS = 30_000;
const API_ENDPOINTS = [
  { market: 'KOSPI', path: 'sto/stk_bydd_trd' },
  { market: 'KOSDAQ', path: 'sto/ksq_bydd_trd' },
  { market: 'KONEX', path: 'sto/knx_bydd_trd' },
];

function seoulDate(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('-', '');
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeCode(row) {
  const candidates = [row.ISU_SRT_CD, row.ISU_CD, row.SRT_CD]
    .map((value) => String(value ?? '').trim().toUpperCase())
    .filter(Boolean);
  return candidates.find((value) => /^[0-9A-Z]{6}$/.test(value)) || '';
}

function calculateReturn(row) {
  const apiReturn = toNumber(row.FLUC_RT);
  if (apiReturn !== null) return apiReturn;

  const close = toNumber(row.TDD_CLSPRC);
  const change = toNumber(row.CMPPREVDD_PRC);
  const previousClose = close !== null && change !== null ? close - change : null;
  if (previousClose && close !== null) {
    return Number((((close / previousClose) - 1) * 100).toFixed(6));
  }
  return null;
}

async function fetchJson(url, key) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { AUTH_KEY: key, Accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await response.text();
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403
        ? '인증키 유효기간 또는 해당 주식 API 3종의 활용승인 상태를 확인해야 합니다.'
        : body.slice(0, 300);
      throw new Error(`HTTP ${response.status}: ${hint}`);
    }
    try {
      return JSON.parse(body);
    } catch {
      throw new Error(`JSON이 아닌 응답 수신: ${body.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchMarketRows(endpoint, basDd, key) {
  const url = new URL(`https://data-dbg.krx.co.kr/svc/apis/${endpoint.path}`);
  url.searchParams.set('basDd', basDd);
  const payload = await fetchJson(url, key);
  const rows = payload.OutBlock_1;
  if (!Array.isArray(rows)) {
    throw new Error(`OutBlock_1 배열이 없습니다: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return rows;
}

async function collectStockReturns() {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error('KRX_API_KEY가 필요합니다.');

  let lastEmptyDate = '';
  for (let daysAgo = 0; daysAgo <= MAX_LOOKBACK_DAYS; daysAgo += 1) {
    const basDd = seoulDate(daysAgo);
    const marketResults = [];

    for (const endpoint of API_ENDPOINTS) {
      try {
        const rows = await fetchMarketRows(endpoint, basDd, key);
        marketResults.push({ ...endpoint, rows });
      } catch (error) {
        throw new Error(`${endpoint.market} 개별종목 API 실패 (${basDd}): ${error.message}`);
      }
    }

    const totalRows = marketResults.reduce((sum, result) => sum + result.rows.length, 0);
    if (!totalRows) {
      lastEmptyDate = basDd;
      continue;
    }

    const items = {};
    const marketCounts = {};
    for (const result of marketResults) {
      marketCounts[result.market] = result.rows.length;
      for (const row of result.rows) {
        const code = normalizeCode(row);
        if (!code) continue;
        items[code] = {
          code,
          name: String(row.ISU_NM ?? '').trim(),
          market: result.market,
          date: String(row.BAS_DD ?? basDd).trim() || basDd,
          close: toNumber(row.TDD_CLSPRC),
          change: toNumber(row.CMPPREVDD_PRC),
          returnPct: calculateReturn(row),
        };
      }
    }

    if (!Object.keys(items).length) {
      throw new Error(`${basDd} 응답 ${totalRows}건에서 6자리 종목코드를 추출하지 못했습니다.`);
    }

    const output = {
      meta: {
        date: basDd,
        status: 'completed',
        total: Object.keys(items).length,
        marketCounts,
        updatedAt: new Date().toISOString(),
      },
      items,
    };
    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
    console.log(`개별종목 수익률 수집 완료: ${basDd}, ${output.meta.total}종목`);
    return output;
  }

  throw new Error(`최근 ${MAX_LOOKBACK_DAYS}일 동안 개별종목 데이터가 없습니다. 마지막 빈 조회일: ${lastEmptyDate}`);
}

if (require.main === module) {
  collectStockReturns().catch((error) => {
    console.error('개별종목 수익률 수집 실패:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { collectStockReturns, calculateReturn, normalizeCode };
