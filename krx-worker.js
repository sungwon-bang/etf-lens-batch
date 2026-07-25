const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const {
  loginContext,
  SESSION_PATH,
  WINDOWS_CHROME_USER_AGENT,
} = require('./krx-auto-login');
const { downloadComposition } = require('./krx-etf-download');

const OUTPUT_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const CHECKPOINT_SIZE = Math.max(1, Number(process.env.CHECKPOINT_SIZE || 25));
const SESSION_MAX_AGE_MS = 20 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 8 * 60 * 1000;
const ETF_TIMEOUT_MS = 4 * 60 * 1000;
const BATCH_TIMEOUT_MS = Math.max(
  10 * 60 * 1000,
  Number(process.env.BATCH_TIMEOUT_MS || 25 * 60 * 1000),
);
const MAX_LOOKBACK_DAYS = 14;
const KRX_CONTEXT_OPTIONS = {
  userAgent: WINDOWS_CHROME_USER_AGENT,
  locale: 'ko-KR',
  timezoneId: 'Asia/Seoul',
  extraHTTPHeaders: {
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
  },
};
let runtimeState;

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} 제한시간 ${Math.round(timeoutMs / 1000)}초 초과`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function seoulDate(daysAgo = 0) {
  const date = new Date(Date.now() - daysAgo * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('-', '');
}

async function fetchEtfUniverse() {
  const key = process.env.KRX_API_KEY;
  if (!key) throw new Error('KRX_API_KEY가 필요합니다.');
  for (let daysAgo = 0; daysAgo <= MAX_LOOKBACK_DAYS; daysAgo += 1) {
    const basDd = seoulDate(daysAgo);
    const url = new URL('https://data-dbg.krx.co.kr/svc/apis/etp/etf_bydd_trd');
    url.searchParams.set('basDd', basDd);
    const response = await fetch(url, { headers: { AUTH_KEY: key } });
    if (!response.ok) throw new Error(`KRX ETF 목록 API 오류 (${response.status})`);
    const rows = (await response.json()).OutBlock_1;
    if (Array.isArray(rows) && rows.length) {
      return {
        date: basDd,
        etfs: rows.map((row) => ({
          code: String(row.ISU_CD ?? '').trim().toUpperCase(),
          name: String(row.ISU_NM ?? '').trim(),
        })).filter((item) => /^[0-9A-Z]{6}$/.test(item.code) && item.name),
      };
    }
  }
  throw new Error(`최근 ${MAX_LOOKBACK_DAYS}일 내 ETF 목록이 없습니다.`);
}

function initialState(date, etfs) {
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8')); } catch {}
  if (previous.meta?.date === date) {
    previous.meta.total = etfs.length;
    previous.meta.updatedAt = new Date().toISOString();
    previous.failures ??= {};
    previous.items ??= {};
    return previous;
  }
  return {
    meta: { date, total: etfs.length, completed: 0, failed: 0, status: 'running', updatedAt: new Date().toISOString() },
    items: {},
    failures: {},
  };
}

function writeState(state) {
  state.meta.completed = Object.keys(state.items).length;
  state.meta.failed = Object.keys(state.failures).length;
  state.meta.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

function publishCheckpoint(message) {
  if (!process.env.GITHUB_ACTIONS) return;
  try {
    execFileSync('git', ['diff', '--quiet', '--', 'data/etf-compositions.json']);
    return;
  } catch {}
  execFileSync('git', ['config', 'user.name', 'github-actions[bot]']);
  execFileSync('git', ['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  execFileSync('git', ['add', 'data/etf-compositions.json']);
  execFileSync('git', ['commit', '-m', message], { stdio: 'inherit' });
  execFileSync('git', ['push'], { stdio: 'inherit' });
}

async function main() {
  const { date, etfs } = await fetchEtfUniverse();
  const filterCode = String(process.env.ETF_CODE_FILTER || '').trim();
  const targetEtfs = filterCode
    ? etfs.filter((etf) => etf.code === filterCode)
    : etfs;
  if (filterCode && !targetEtfs.length) {
    throw new Error(`ETF 목록에서 검증 종목 ${filterCode}을 찾지 못했습니다.`);
  }
  const state = initialState(date, targetEtfs);
  runtimeState = state;
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  let context;
  let collectionPage;
  let sessionStartedAt = 0;

  const renewSession = async () => {
    await context?.close().catch(() => {});
    collectionPage = undefined;
    fs.rmSync(SESSION_PATH, { force: true });
    context = await browser.newContext({
      ...KRX_CONTEXT_OPTIONS,
      acceptDownloads: true,
    });
    const authenticated = await withTimeout(
      loginContext(context, { saveSession: false }),
      LOGIN_TIMEOUT_MS,
      'KRX 로그인 및 PDF 화면 확인',
    );
    collectionPage = authenticated.page;
    sessionStartedAt = Date.now();
    console.log('수집에 재사용할 동일 페이지에서 KRX 로그인을 완료했습니다.');
  };

  const collect = async (etf) => {
    if (!context || Date.now() - sessionStartedAt >= SESSION_MAX_AGE_MS) await renewSession();
    const components = await withTimeout(
      downloadComposition(
        context,
        { ...etf, date },
        collectionPage,
      ),
      ETF_TIMEOUT_MS,
      `ETF ${etf.code} PDF 수집`,
    );
    state.items[etf.code] = {
      etf: { ...etf, date },
      summary: {
        totalComponents: components.length,
        totalWeight: components.reduce((sum, item) => sum + item.weight, 0),
      },
      components,
      collectedAt: new Date().toISOString(),
    };
    delete state.failures[etf.code];
  };

  try {
    await renewSession();
    delete state.failures._batch;
    const pending = targetEtfs.filter((etf) => !state.items[etf.code]);
    console.log(`기준일 ${date}: 전체 ${targetEtfs.length}개, 남은 ${pending.length}개`);
    let sinceCheckpoint = 0;

    for (const etf of pending) {
      try {
        await collect(etf);
        console.log(`완료 ${etf.code} ${etf.name}`);
      } catch (error) {
        state.failures[etf.code] = { ...etf, attempts: 1, error: error.message };
        console.error(`1차 실패 ${etf.code}: ${error.message}`);
        await renewSession().catch((loginError) => console.error(`재로그인 실패: ${loginError.message}`));
      }
      writeState(state);
      sinceCheckpoint += 1;
      if (sinceCheckpoint >= CHECKPOINT_SIZE) {
        publishCheckpoint(`data: checkpoint ETF PDF ${state.meta.completed}/${state.meta.total}`);
        sinceCheckpoint = 0;
      }
    }

    for (let round = 2; round <= 3 && Object.keys(state.failures).length; round += 1) {
      const failures = Object.values(state.failures);
      console.log(`실패 종목 ${round}차 시도: ${failures.length}개`);
      await renewSession();
      for (const etf of failures) {
        try {
          await collect(etf);
          console.log(`재시도 완료 ${etf.code} ${etf.name}`);
        } catch (error) {
          state.failures[etf.code] = { ...etf, attempts: round, error: error.message };
          console.error(`${round}차 실패 ${etf.code}: ${error.message}`);
        }
        writeState(state);
      }
      publishCheckpoint(`data: retry ETF PDF round ${round}`);
    }

    state.meta.status = Object.keys(state.failures).length ? 'partial' : 'completed';
    writeState(state);
    publishCheckpoint(`data: complete ETF PDF ${state.meta.completed}/${state.meta.total}`);
    if (state.meta.status !== 'completed') process.exitCode = 1;
  } finally {
    await context?.close().catch(() => {});
    await browser.close();
    fs.rmSync(SESSION_PATH, { force: true });
  }
}

withTimeout(main(), BATCH_TIMEOUT_MS, 'ETF PDF 배치 전체 실행').catch((error) => {
  console.error('전체 ETF PDF 배치 실패:', error.message);
  const state = runtimeState || {
    meta: {
      date: seoulDate(),
      total: 0,
      completed: 0,
      failed: 0,
      status: 'failed',
      updatedAt: new Date().toISOString(),
    },
    items: {},
    failures: {},
  };
  state.failures ??= {};
  state.failures._batch = {
    stage: 'batch-initialization',
    error: error.message,
    failedAt: new Date().toISOString(),
  };
  state.meta.status = 'failed';
  writeState(state);
  publishCheckpoint('data: record fatal ETF PDF batch error');
  // Promise.race cannot cancel a stuck Playwright operation. Exit explicitly
  // after the failure checkpoint so the workflow can upload diagnostics and
  // release the self-hosted runner.
  process.exit(1);
});
