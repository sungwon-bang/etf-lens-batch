const { chromium } = require('playwright');
const fs = require('fs');
require('dotenv').config();

const SESSION_PATH = 'krx-session.json';
const KRX_HOME_URL = 'https://data.krx.co.kr/';
const KRX_COMPOSITION_URL =
  'https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201030108';
const KRX_FINDER_SELECTOR = '[id^="btnisuCd_finder_secuprodisu1_"]:visible';
const LOGIN_LINK_SELECTOR = 'a[href*="MDCCOMS001.cmd"]';
const KRX_LOGIN_PAGE_URL =
  'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001.cmd';
const KRX_LOGIN_IFRAME_URL =
  'https://data.krx.co.kr/contents/MDC/COMS/client/view/login.jsp?site=mdc';
const KRX_LOGIN_REQUEST_URL =
  'https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001D1.cmd';
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
      // KRX occasionally completes the click but keeps the navigation request
      // open long enough for Playwright's implicit navigation wait to time out.
      // The login form is detected separately by findLoginFrame(), so do not
      // make the click itself depend on navigation completion.
      await candidate.click({
        force: true,
        timeout: 10_000,
        noWaitAfter: true,
      });
      return;
    }
  }
  await saveDiagnostics(page, 'login-entry-not-found');
  throw new Error(`KRX 로그인 진입 버튼을 찾지 못했습니다. 현재 URL: ${page.url()}`);
}

async function findAuthenticatedCompositionPage(context, preferredPages) {
  const candidates = [...new Set([
    ...preferredPages,
    ...context.pages(),
  ])].filter((candidate) => candidate && !candidate.isClosed());
  const diagnostics = [];

  for (const candidate of candidates) {
    try {
      await candidate.goto(KRX_COMPOSITION_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      const finder = candidate.locator(KRX_FINDER_SELECTOR).first();
      if (await finder.waitFor({
        state: 'visible',
        timeout: 15_000,
      }).then(() => true).catch(() => false)) {
        console.log(`KRX 인증 PDF 페이지 확인: ${candidate.url()}`);
        return candidate;
      }
      diagnostics.push({
        url: candidate.url(),
        title: await candidate.title().catch(() => ''),
        body: (await candidate.locator('body').innerText().catch(() => ''))
          .replace(/\s+/g, ' ')
          .slice(0, 300),
      });
    } catch (error) {
      diagnostics.push({
        url: candidate.url(),
        error: error.message,
      });
    }
  }

  await Promise.all(candidates.map((candidate, index) =>
    saveDiagnostics(candidate, `authenticated-page-not-found-${index}`),
  ));
  throw new Error(
    `로그인 후 인증된 PDF 페이지를 찾지 못했습니다: ${JSON.stringify(diagnostics)}`,
  );
}

async function loginByRequest(context, id, password) {
  const headers = {
    'User-Agent': WINDOWS_CHROME_USER_AGENT,
    Referer: KRX_LOGIN_PAGE_URL,
  };
  await context.request.get(KRX_LOGIN_PAGE_URL, { headers, timeout: 30_000 });
  await context.request.get(KRX_LOGIN_IFRAME_URL, { headers, timeout: 30_000 });

  const form = {
    mbrNm: '',
    telNo: '',
    di: '',
    certType: '',
    mbrId: id,
    pw: password,
  };
  let response = await context.request.post(KRX_LOGIN_REQUEST_URL, {
    form,
    headers,
    timeout: 30_000,
  });
  if (!response.ok()) {
    throw new Error(`KRX 인증 요청 HTTP 오류: ${response.status()}`);
  }
  let data = await response.json();
  if (data._error_code === 'CD011') {
    response = await context.request.post(KRX_LOGIN_REQUEST_URL, {
      form: { ...form, skipDup: 'Y' },
      headers,
      timeout: 30_000,
    });
    if (!response.ok()) {
      throw new Error(`KRX 중복 로그인 승인 HTTP 오류: ${response.status()}`);
    }
    data = await response.json();
  }
  if (data._error_code !== 'CD001') {
    throw new Error(
      `KRX 인증 거절: ${data._error_code || 'UNKNOWN'} ${data._error_message || ''}`.trim(),
    );
  }
  console.log('KRX 직접 인증 응답 확인: CD001');
}

async function loginContext(context, { saveSession = true } = {}) {
  const id = process.env.KRX_LOGIN_ID;
  const password = process.env.KRX_LOGIN_PASSWORD;
  if (!id || !password) throw new Error('KRX_LOGIN_ID와 KRX_LOGIN_PASSWORD가 필요합니다.');

  try {
    await loginByRequest(context, id, password);
    const directPage = await context.newPage();
    const authenticatedPage = await findAuthenticatedCompositionPage(
      context,
      [directPage],
    );
    const state = await context.storageState();
    if (!state.cookies.length) throw new Error('로그인 세션 쿠키가 생성되지 않았습니다.');
    if (saveSession) {
      fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
    }
    console.log(`KRX 직접 인증 및 PDF 접근 완료: 쿠키 ${state.cookies.length}개`);
    return { context, page: authenticatedPage };
  } catch (directError) {
    console.warn(`KRX 직접 인증 실패, 화면 로그인으로 대체: ${directError.message}`);
  }

  try {
    const page = await context.newPage();
    const acceptDialog = async (dialog) => {
      console.log(`KRX 대화상자 자동 승인: ${dialog.type()}`);
      await dialog.accept().catch(() => {});
    };
    page.on('dialog', acceptDialog);
    context.on('page', (newPage) => {
      newPage.on('dialog', acceptDialog);
    });
    await loadKrxHome(page);
    await clickLoginEntry(page);

    const surface = await findLoginFrame(() => context.pages());
    if (!surface) {
      await Promise.all(context.pages().map((item, index) =>
        saveDiagnostics(item, `login-form-not-found-${index}`),
      ));
      throw new Error(`KRX 로그인 입력창을 찾지 못했습니다. 현재 URL: ${page.url()}`);
    }

    let currentSurface = surface;
    let authenticatedPage;
    let lastAuthError;

    for (let attempt = 1; attempt <= LOGIN_MAX_ATTEMPTS; attempt += 1) {
      const { page: loginPage, frame } = currentSurface;
      const idInput = frame.locator('input[name="mbrId"]').first();
      const passwordInput = frame.locator(
        'input[name="pw"], input[type="password"], input[placeholder*="비밀번호"]',
      ).first();
      await idInput.fill(id);
      await passwordInput.fill(password);
      await passwordInput.press('Enter');

      // Do not interrupt the popup while KRX is finalizing its server-side
      // session. The form disappearing alone is not proof of authentication.
      await Promise.race([
        loginPage.waitForEvent('close', { timeout: 30_000 }),
        loginPage.waitForLoadState('networkidle', { timeout: 30_000 }),
      ]).catch(() => {});
      await page.waitForTimeout(3_000);
      if (!loginPage.isClosed() && loginPage !== page) {
        await loginPage.close().catch(() => {});
      }

      try {
        authenticatedPage = await findAuthenticatedCompositionPage(
          context,
          [page],
        );
        lastAuthError = undefined;
        break;
      } catch (error) {
        lastAuthError = error;
        console.warn(
          `KRX 로그인 실검증 재시도 ${attempt}/${LOGIN_MAX_ATTEMPTS}: ${error.message}`,
        );
      }

      if (attempt < LOGIN_MAX_ATTEMPTS) {
        await page.waitForTimeout(LOGIN_RETRY_DELAY_MS);
        // Authentication validation can leave the original entry tab on a
        // server-generated login redirect. Reusing that tab intermittently
        // prevents KRX from creating a new login surface, so start every retry
        // from a clean tab.
        const retryEntryPage = await context.newPage();
        await loadKrxHome(retryEntryPage);
        await clickLoginEntry(retryEntryPage);
        currentSurface = await findLoginFrame(() => context.pages());
        if (!currentSurface) {
          await Promise.all(context.pages().map((item, index) =>
            saveDiagnostics(item, `login-retry-form-not-found-${attempt}-${index}`),
          ));
          const pageStates = await Promise.all(context.pages().map(async (item) => ({
            url: item.url(),
            title: await item.title().catch(() => ''),
          })));
          throw new Error(
            `KRX 로그인 재시도 입력창을 찾지 못했습니다: ${JSON.stringify(pageStates)}`,
          );
        }
      }
    }

    if (!authenticatedPage) {
      throw lastAuthError || new Error('KRX 로그인 실검증에 실패했습니다.');
    }

    const state = await context.storageState();
    if (!state.cookies.length) throw new Error('로그인 세션 쿠키가 생성되지 않았습니다.');
    if (saveSession) {
      fs.writeFileSync(SESSION_PATH, JSON.stringify(state, null, 2));
    }
    console.log(`KRX 로그인 및 PDF 접근 완료: 쿠키 ${state.cookies.length}개`);
    return {
      context,
      page: authenticatedPage,
    };
  } finally {
    // The caller owns the context. Keeping it open is required because KRX does
    // not accept a session copied into a different browser context.
  }
}

async function login() {
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
    await loginContext(context);
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
  loginContext,
  SESSION_PATH,
  KRX_HOME_URL,
  KRX_COMPOSITION_URL,
  KRX_FINDER_SELECTOR,
  LOGIN_LINK_SELECTOR,
  DIAGNOSTIC_DIR,
  KRX_UNAVAILABLE_TEXT,
  HOME_MAX_ATTEMPTS,
  HOME_RETRY_DELAY_MS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_RETRY_DELAY_MS,
  WINDOWS_CHROME_USER_AGENT,
  KRX_LOGIN_PAGE_URL,
  KRX_LOGIN_IFRAME_URL,
  KRX_LOGIN_REQUEST_URL,
  loginByRequest,
  loadKrxHome,
  clickLoginEntry,
  findLoginFrame,
  findAuthenticatedCompositionPage,
  saveDiagnostics,
};
