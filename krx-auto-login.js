const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config();

const id = process.env.KRX_LOGIN_ID;
const password = process.env.KRX_LOGIN_PASSWORD;

async function main() {
  if (!id || !password) throw new Error('KRX_LOGIN_ID와 KRX_LOGIN_PASSWORD가 필요합니다.');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto('https://data.krx.co.kr/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.locator('a[href*="MDCCOMS001.cmd"]').first().click({ timeout: 15_000 });
    await page.waitForTimeout(2_000);

    const frame = page.frames().find((item) => item.url().includes('login.jsp'));
    if (!frame) throw new Error('KRX 로그인 프레임을 찾지 못했습니다.');

    const idInput = frame.locator('input[name="mbrId"]').first();
    const pwInput = frame.locator('input[name="pw"]').first();
    await idInput.fill(id);
    await pwInput.fill(password);
    await pwInput.press('Enter');
    await page.waitForTimeout(5_000);

    const state = await context.storageState();
    if (!state.cookies.length) throw new Error('로그인 세션 쿠키가 생성되지 않았습니다.');
    fs.writeFileSync('krx-session.json', JSON.stringify(state, null, 2));
    console.log(`KRX 세션 저장 완료: 쿠키 ${state.cookies.length}개`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('KRX 로그인 실패:', error.message);
  process.exitCode = 1;
});
