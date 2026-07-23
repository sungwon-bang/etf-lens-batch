const { spawn } = require('child_process');
const fs = require('fs');
require('dotenv').config();

const SITE_URL = process.env.ETF_SITE_URL?.replace(/\/$/, '');
const SITE_TOKEN = process.env.ETF_SITE_TOKEN;
const MAX_JOBS = Number(process.env.MAX_PDF_JOBS || 100);

if (!SITE_URL || !SITE_TOKEN) {
  throw new Error('ETF_SITE_URL과 ETF_SITE_TOKEN GitHub Secret이 필요합니다.');
}

const headers = {
  'Content-Type': 'application/json',
  'OAI-Sites-Authorization': `Bearer ${SITE_TOKEN}`,
};

async function claimJob() {
  const response = await fetch(`${SITE_URL}/api/pdf/jobs/claim`, { method: 'POST', headers });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error(`작업 조회 실패 (${response.status})`);
  return (await response.json()).job;
}

async function failJob(id, error) {
  const response = await fetch(`${SITE_URL}/api/pdf/jobs/fail`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id, error: String(error).slice(0, 500) }),
  });
  if (!response.ok) console.error(`실패 상태 보고 오류 (${response.status})`);
}

function run(script, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function ensureLogin() {
  if (fs.existsSync('krx-session.json')) return true;
  return run('krx-auto-login.js');
}

async function collect(job) {
  console.log(`PDF 수집: ${job.name} (${job.code}) / ${job.date}`);
  let success = await ensureLogin() && await run('krx-etf-download.js', [job.code, job.date, job.name]);
  if (!success) {
    console.log('세션을 갱신하고 한 번 재시도합니다.');
    fs.rmSync('krx-session.json', { force: true });
    success = await run('krx-auto-login.js') && await run('krx-etf-download.js', [job.code, job.date, job.name]);
  }
  if (!success) await failJob(job.id, 'KRX 로그인 또는 PDF 구성종목 다운로드 실패');
  return success;
}

async function main() {
  let claimed = 0;
  let completed = 0;
  while (claimed < MAX_JOBS) {
    const job = await claimJob();
    if (!job) break;
    claimed += 1;
    if (await collect(job)) completed += 1;
  }
  console.log(`PDF 요청 처리 종료: 요청 ${claimed}건, 완료 ${completed}건`);
  if (claimed > 0 && completed === 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('PDF 배치 실패:', error.message);
  process.exitCode = 1;
});
