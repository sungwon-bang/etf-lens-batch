const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const KRX_API_KEY = process.env.KRX_API_KEY;
const OUTPUT_PATH = path.join(__dirname, 'etf-data.json');
const KRX_TIME_ZONE = 'Asia/Seoul';
const MAX_LOOKBACK_DAYS = 14;

const krxApi = axios.create({
  baseURL: 'https://data-dbg.krx.co.kr/svc/apis',
  headers: { AUTH_KEY: KRX_API_KEY },
  timeout: 60_000
});

function formatKrxDate(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: KRX_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date).replaceAll('-', '');
}

function dateDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function number(value) {
  const parsed = Number(String(value ?? '').replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

async function fetchLatestEtfMarket() {
  for (let daysAgo = 0; daysAgo <= MAX_LOOKBACK_DAYS; daysAgo += 1) {
    const basDd = formatKrxDate(dateDaysAgo(daysAgo));
    const response = await krxApi.get('/etp/etf_bydd_trd', {
      params: { basDd }
    });
    const rows = response.data?.OutBlock_1;

    if (Array.isArray(rows) && rows.length > 0) {
      return { basDd, rows };
    }

    console.log(`거래 데이터 없음: ${basDd}`);
  }

  throw new Error(`최근 ${MAX_LOOKBACK_DAYS}일 내 ETF 일별매매정보가 없습니다.`);
}

function readPreviousData() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function buildResults(rows, basDd, previousData) {
  const timestamp = new Date().toISOString();

  return Object.fromEntries(rows.map((row) => {
    const code = String(row.ISU_CD ?? '').trim().toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(code)) {
      throw new Error(`올바르지 않은 ETF 종목코드: ${code || '(빈 값)'}`);
    }

    const previous = previousData[code] ?? {};
    const components = Array.isArray(previous.components) ? previous.components : [];
    const hasSameDateComponents = previous.date === basDd && components.length > 0;

    return [code, {
      etf: {
        code,
        name: String(row.ISU_NM ?? '').trim(),
        marketPrice: number(row.TDD_CLSPRC),
        priceChange: number(row.CMPPREVDD_PRC),
        priceChangePercent: number(row.FLUC_RT),
        nav: number(row.NAV),
        marketCap: number(row.MKTCAP)
      },
      // PDF 구성종목은 별도 로그인 수집 결과가 같은 기준일일 때만 유지한다.
      components: hasSameDateComponents ? components : [],
      summary: {
        totalComponents: hasSameDateComponents ? components.length : 0,
        totalContribution: hasSameDateComponents
          ? components.reduce((sum, item) => sum + number(item.contribution), 0)
          : 0,
        compositionStatus: hasSameDateComponents ? 'collected' : 'pending'
      },
      date: basDd,
      timestamp
    }];
  }));
}

async function main() {
  if (!KRX_API_KEY) {
    throw new Error('환경변수 KRX_API_KEY가 없습니다.');
  }

  console.log('KRX 전체 ETF 일별매매정보 수집 시작');
  const previousData = readPreviousData();
  const { basDd, rows } = await fetchLatestEtfMarket();
  const results = buildResults(rows, basDd, previousData);
  const count = Object.keys(results).length;

  if (count === 0) {
    throw new Error('수집 결과가 0건이므로 기존 파일을 덮어쓰지 않습니다.');
  }

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
  console.log(`수집 완료: 기준일 ${basDd}, ETF ${count}개`);
}

main().catch((error) => {
  console.error('배치 실패:', error.response?.data ?? error.message);
  process.exitCode = 1;
});
