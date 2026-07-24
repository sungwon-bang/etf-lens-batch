const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config();

const SESSION_PATH = 'krx-session.json';
const LOGIN_URL = 'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001.cmd';

async function findLoginScope(page) {
  const candidates = [page, ...page.frames()];
  for (const scope of candidates) {
    const idInput = scope.locator('input[name="mbrId"], input[id*="mbrId"]').first();
    if (await idInput.isVisible().catch(() => false)) return scope;
  }
  return null;
}

async function login() {
  const id = process.env.KRX_LOGIN_ID;
  const password = process.env.KRX_LOGIN_PASSWORD;
  if (!id || !password) throw new Error('KRX_LOGIN_ID와 KRX_LOGIN_PASSWORD가 필요합니다.');

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(2_000);
    const scope = await findLoginScope(page);
    if (!scope) throw new Error(`KRX 로그인 입력창을 찾지 못했습니다. 현재 URL: ${page.url()}`);
    await scope.locator('input[name="mbrId"], input[id*="mbrId"]').first().fill(id);
    const passwordInput = scope.locator('input[name="pw"], input[type="password"]').first();
    await passwordInput.fill(password);
    await passwordInput.press('Enter');
    await page.waitForTimeout(5_000);
    const state = await context.storageState();
    if (!state.cookies.length) throw new Error('로그인 세션 쿠키가 생성되지 않았습니다.');
    fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
    console.log(`KRX 로그인 완료: 쿠키 ${state.cookies.length}개`);
    return SESSION_PATH;
  } finally {
    await browser.close();
  }
}

if (require.main === module) {
  login().catch((error) => {
    console.error('KRX 로그인 실패:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { login, SESSION_PATH, LOGIN_URL, findLoginScope };
