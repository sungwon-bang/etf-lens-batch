const { chromium } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
require('dotenv').config();
const { login, SESSION_PATH } = require('./krx-auto-login');
const { downloadComposition } = require('./krx-etf-download');

const OUTPUT_PATH = path.join(__dirname, 'data', 'etf-compositions.json');
const CHECKPOINT_SIZE = Math.max(1, Number(process.env.CHECKPOINT_SIZE || 25));
const SESSION_MAX_AGE_MS = 20 * 60 * 1000;
const MAX_LOOKBACK_DAYS = 14;

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
  const state = initialState(date, etfs);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  let context;
  let sessionStartedAt = 0;

  const openSavedSession = async () => {
    if (!fs.existsSync(SESSION_PATH)) return false;
    await context?.close().catch(() => {});
    context = await browser.newContext({ storageState: SESSION_PATH, acceptDownloads: true });
    sessionStartedAt = Date.now();
    console.log('로그인 전용 단계에서 저장한 KRX 세션을 불러왔습니다.');
    return true;
  };

  const renewSession = async () => {
    await context?.close().catch(() => {});
    fs.rmSync(SESSION_PATH, { force: true });
    await login();
    context = await browser.newContext({ storageState: SESSION_PATH, acceptDownloads: true });
    sessionStartedAt = Date.now();
  };

  const collect = async (etf) => {
    if (!context || Date.now() - sessionStartedAt >= SESSION_MAX_AGE_MS) await renewSession();
    const components = await downloadComposition(context, { ...etf, date });
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
    if (!(await openSavedSession())) await renewSession();
    const pending = etfs.filter((etf) => !state.items[etf.code]);
    console.log(`기준일 ${date}: 전체 ${etfs.length}개, 남은 ${pending.length}개`);
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

main().catch((error) => {
  console.error('전체 ETF PDF 배치 실패:', error.message);
  process.exitCode = 1;
});
