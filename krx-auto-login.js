const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config();

const SESSION_PATH = 'krx-session.json';
const KRX_HOME_URL = 'https://data.krx.co.kr/';
const LOGIN_LINK_SELECTOR = 'a[href*="MDCCOMS001.cmd"]';
const DIAGNOSTIC_DIR = 'diagnostics';
const KRX_UNAVAILABLE_TEXT = 'Service unavailable';
const HOME_MAX_ATTEMPTS = 8;
const HOME_RETRY_DELAY_MS = 15_000;
const LOGIN_MAX_ATTEMPTS = 4;
const LOGIN_RETRY_DELAY_MS = 60_000;
const WINDOWS_CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/149.0.0.0 Safari/537.36';

async function loadKrxHome(
  page,
  maxAttempts = HOME_MAX_ATTEMPTS,
  retryDelayMs = HOME_RETRY_DELAY_MS,
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await page.goto(KRX_HOME_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      const bodyText = await page.locator('body').innerText().catch(() => '');
      if (!bodyText.includes(KRX_UNAVAILABLE_TEXT)) {
        console.log(`KRX 메인 접속 완료 (${attempt}/${maxAttempts})`);
        return;
      }
      lastError = new Error('KRX가 Service unavailable 페이지를 반환했습니다.');
    } catch (error) {
      lastError = error;
    }

    console.warn(
      `KRX 메인 접속 재시도 ${attempt}/${maxAttempts}: ${lastError.message}`,
    );
    if (attempt < maxAttempts) await page.waitForTimeout(retryDelayMs);
  }

  await saveDiagnostics(page, 'krx-home-unavailable');
  throw lastError;
}

async function saveDiagnostics(page, label) {
  fs.mkdirSync(DIAGNOSTIC_DIR, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '-');
  await page.screenshot({
    path: `${DIAGNOSTIC_DIR}/${safeLabel}.png`,
    fullPage: true,
  }).catch(() => {});
  fs.writeFileSync(
    `${DIAGNOSTIC_DIR}/${safeLabel}.html`,
    await page.content().catch(() => ''),
  );
  const controls = await page.locator('a, button, [onclick]').evaluateAll((items) =>
    items.slice(0, 100).map((item) => ({
      tag: item.tagName,
      text: (item.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      href: item.getAttribute('href'),
      onclick: item.getAttribute('onclick'),
      id: item.id,
      className: item.className,
    })),
  ).catch(() => []);
  fs.writeFileSync(
    `${DIAGNOSTIC_DIR}/${safeLabel}-controls.json`,
    `${JSON.stringify(controls, null, 2)}\n`,
  );
}

async function findLoginFrame(pages, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of pages()) {
      for (const frame of page.frames()) {
        const idInput = frame.locator(
          'input[name="mbrId"], input[placeholder*="아이디"]',
        );
        if (await idInput.first().isVisible().catch(() => false)) {
          return { page, frame };
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

async function clickLoginEntry(page) {
  const candidates = [
    LOGIN_LINK_SELECTOR,
    'a[href*="/contents/MDC/COMS/client/MDCCOMS001.cmd"]',
    '[onclick*="MDCCOMS001"]',
    'a:has-text("로그인")',
    'button:has-text("로그인")',
    'img[alt*="로그인"]',
    'img[title*="로그인"]',
  ];
  for (const selector of candidates) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      console.log(`KRX 로그인 진입 선택자: ${selector}`);
      await candidate.click({ force: true, timeout: 10_000 });
      return;
    }
  }
  await saveDiagnostics(page, 'login-entry-not-found');
  throw new Error(`KRX 로그인 진입 버튼을 찾지 못했습니다. 현재 URL: ${page.url()}`);
}

async function login() {
  const id = process.env.KRX_LOGIN_ID;
  const password = process.env.KRX_LOGIN_PASSWORD;
  if (!id || !password) throw new Error('KRX_LOGIN_ID와 KRX_LOGIN_PASSWORD가 필요합니다.');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  try {
    const context = await browser.newContext({
      userAgent: WINDOWS_CHROME_USER_AGENT,
      locale: 'ko-KR',
      timezoneId: 'Asia/Seoul',
      extraHTTPHeaders: {
        'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    const page = await context.newPage();
    await loadKrxHome(page);
    await clickLoginEntry(page);

    const surface = await findLoginFrame(() => context.pages());
    if (!surface) {
      await Promise.all(context.pages().map((item, index) =>
        saveDiagnostics(item, `login-form-not-found-${index}`),
      ));
      throw new Error(`KRX 로그인 입력창을 찾지 못했습니다. 현재 URL: ${page.url()}`);
    }

    const { frame } = surface;
    const idInput = frame.locator('input[name="mbrId"]').first();
    const passwordInput = frame.locator(
      'input[name="pw"], input[type="password"], input[placeholder*="비밀번호"]',
    ).first();
    let loggedIn = false;
    for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
      await idInput.fill(id);
      await passwordInput.fill(password);
      await passwordInput.press('Enter');
      await page.waitForTimeout(5_000);
      if (!(await idInput.isVisible().catch(() => false))) {
        loggedIn = true;
        break;
      }
      console.warn(`KRX 로그인 제출 재시도 ${attempt}/${LOGIN_MAX_ATTEMPTS}`);
      if (attempt < LOGIN_MAX_ATTEMPTS) {
        await page.waitForTimeout(LOGIN_RETRY_DELAY_MS);
      }
    }

    if (!loggedIn) {
      await saveDiagnostics(page, 'login-submit-rejected');
      throw new Error('KRX가 로그인 제출을 반복해서 거절했습니다.');
    }

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

module.exports = {
  login,
  SESSION_PATH,
  KRX_HOME_URL,
  LOGIN_LINK_SELECTOR,
  DIAGNOSTIC_DIR,
  KRX_UNAVAILABLE_TEXT,
  HOME_MAX_ATTEMPTS,
  HOME_RETRY_DELAY_MS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_RETRY_DELAY_MS,
  WINDOWS_CHROME_USER_AGENT,
  loadKrxHome,
  clickLoginEntry,
  findLoginFrame,
  saveDiagnostics,
};
