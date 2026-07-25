const fs = require('fs');
const path = require('path');

const COMPOSITION_MENU_ID = 'MDC0201030108';
const COMPOSITION_URL =
  `https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=${COMPOSITION_MENU_ID}`;

function csvRows(text) {
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const values = [];
    let value = '';
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"' && line[index + 1] === '"' && quoted) { value += '"'; index += 1; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { values.push(value.trim()); value = ''; }
      else value += char;
    }
    values.push(value.trim());
    return values;
  });
}

function toNumber(value) {
  const parsed = Number(String(value ?? '').replaceAll(',', '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsv(file) {
  const rows = csvRows(new TextDecoder('euc-kr').decode(fs.readFileSync(file)));
  if (rows.length < 2) throw new Error('다운로드된 CSV가 비어 있습니다.');
  const header = rows[0].map((item) => item.replace(/^"|"$/g, '').trim());
  const find = (...names) => names.map((name) => header.findIndex((item) => item.includes(name))).find((index) => index >= 0) ?? -1;
  const indexes = {
    code: find('종목코드'),
    name: find('구성종목명', '종목명'),
    quantity: find('주식수', '계약수'),
    amount: find('평가금액'),
    marketCap: find('시가총액'),
    weight: find('구성비중', '비중'),
  };
  if (indexes.code < 0 || indexes.name < 0 || indexes.weight < 0) {
    throw new Error(`필수 CSV 열을 찾지 못했습니다: ${header.join(', ')}`);
  }
  return rows.slice(1).map((row) => ({
    code: String(row[indexes.code] ?? '').trim().toUpperCase(),
    name: String(row[indexes.name] ?? '').trim(),
    quantity: indexes.quantity >= 0 ? toNumber(row[indexes.quantity]) : 0,
    evaluationAmount: indexes.amount >= 0 ? toNumber(row[indexes.amount]) : 0,
    marketCap: indexes.marketCap >= 0 ? toNumber(row[indexes.marketCap]) : 0,
    weight: toNumber(row[indexes.weight]),
  })).filter((item) => item.code && item.name && item.weight > 0);
}

async function selectFinderResult(page, { code, name }) {
  const deadline = Date.now() + 20_000;
  const rowSelectors = [
    '[id^="jsLayer_finder_secuprodisu1_"]:visible tr',
    '[id*="finder_secuprodisu1_"]:visible tr',
    '[id*="finder_secuprodisu1_"]:visible [role="row"]',
    '[id*="finder_secuprodisu1_"]:visible li',
    '.CI-GRID-BODY-TABLE-TBODY:visible tr',
    '[role="dialog"]:visible tr',
    '[role="dialog"]:visible [role="row"]',
    'table:visible tbody tr',
  ];

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const selector of rowSelectors) {
        const rows = frame.locator(selector);
        const count = await rows.count();
        for (let index = 0; index < count; index += 1) {
          const row = rows.nth(index);
          const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (!text || (!text.includes(code) && !text.includes(name))) continue;
          console.log(`ETF 검색 결과 행 선택: ${text.slice(0, 120)}`);
          const clickable = row.locator('a, button, [onclick]').first();
          if (await clickable.isVisible().catch(() => false)) {
            await clickable.click({ noWaitAfter: true });
          } else {
            await row.click({ noWaitAfter: true });
          }
          return;
        }
      }

      // KRX finder revisions sometimes render the result as a div/span rather
      // than a table row. Find the smallest visible text node and click its
      // nearest interactive/result container.
      for (const value of [code, name]) {
        const matches = frame.getByText(value, { exact: false });
        const count = Math.min(await matches.count(), 20);
        let best;
        let bestLength = Number.POSITIVE_INFINITY;
        for (let index = 0; index < count; index += 1) {
          const match = matches.nth(index);
          if (!(await match.isVisible().catch(() => false))) continue;
          const text = (await match.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
          if (!text.includes(value) || text.length >= bestLength) continue;
          best = match;
          bestLength = text.length;
        }
        if (best) {
          const container = best.locator(
            'xpath=ancestor-or-self::*[self::tr or self::li or @role="row" or self::a or self::button or @onclick][1]',
          );
          const target = await container.count() ? container.first() : best;
          console.log(`ETF 검색 결과 텍스트 선택: ${(await target.innerText().catch(() => value)).slice(0, 120)}`);
          await target.click({ force: true, noWaitAfter: true });
          return;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  const frameStates = await Promise.all(page.frames().map(async (frame) => ({
    url: frame.url(),
    text: (await frame.locator('body').innerText().catch(() => ''))
      .replace(/\s+/g, ' ')
      .slice(0, 500),
  })));
  throw new Error(
    `ETF 검색 결과가 없습니다. 검색어=${code}, 프레임=${JSON.stringify(frameStates)}`,
  );
}

async function downloadComposition(context, { code, name, date }, existingPage = null) {
  const page = existingPage || await context.newPage();
  const ownsPage = !existingPage;
  let stage = 'start';
  const mark = (nextStage) => {
    stage = nextStage;
    console.log(`[${code}] ${stage}`);
  };
  try {
    const finderButton = page.locator(
      '[id^="btnisuCd_finder_secuprodisu1_"]:visible',
    ).first();
    const alreadyReady = existingPage
      && await finderButton.isVisible().catch(() => false);
    if (!alreadyReady) {
      mark('PDF 화면 이동');
      await page.goto(COMPOSITION_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    } else {
      mark('로그인 검증에 사용한 PDF 화면 재사용');
    }
    mark('종목검색 버튼 대기');
    await finderButton.waitFor({ state: 'visible', timeout: 30_000 });
    mark('종목검색 팝업 열기');
    await finderButton.click({ timeout: 15_000, noWaitAfter: true });

    const search = page.locator(
      '[id^="searchText__finder_secuprodisu1_"]:visible',
    ).first();
    mark('검색 입력창 대기');
    await search.waitFor({ state: 'visible', timeout: 15_000 });
    await search.fill(code, { timeout: 10_000 });
    mark('검색 실행');
    await search.press('Enter', { timeout: 10_000 });
    mark('검색 결과 선택');
    await selectFinderResult(page, { code, name });

    const dateInput = page.locator('input[id*="trdDd"], input[name*="trdDd"], input[id*="basDd"], input[name*="basDd"]').first();
    if (await dateInput.isVisible().catch(() => false)) {
      await dateInput.fill(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`);
    }
    mark('PDF 조회');
    await page.locator('#jsSearchButton').click({ timeout: 15_000, noWaitAfter: true });
    await page.waitForTimeout(3_000);
    mark('다운로드 메뉴 열기');
    await page.locator('img[title*="다운로드"]').first().click({
      timeout: 15_000,
      noWaitAfter: true,
    });
    mark('CSV 다운로드');
    const downloadPromise = page.waitForEvent('download', { timeout: 45_000 });
    await page.locator('a').filter({ hasText: 'CSV' }).last().click({
      timeout: 15_000,
      noWaitAfter: true,
    });
    const download = await downloadPromise;
    const file = path.join(process.cwd(), `krx-${code}-${date}.csv`);
    await download.saveAs(file);
    try {
      const components = parseCsv(file);
      if (!components.length) throw new Error('구성종목이 0건입니다.');
      return components;
    } finally {
      fs.rmSync(file, { force: true });
    }
  } catch (error) {
    fs.mkdirSync('diagnostics', { recursive: true });
    await page.screenshot({
      path: `diagnostics/collect-${code}.png`,
      fullPage: true,
    }).catch(() => {});
    fs.writeFileSync(
      `diagnostics/collect-${code}.html`,
      await page.content().catch(() => ''),
    );
    error.message = `[${code}] ${stage} 실패: ${error.message}`;
    throw error;
  } finally {
    if (ownsPage) await page.close();
  }
}

module.exports = {
  COMPOSITION_MENU_ID,
  COMPOSITION_URL,
  downloadComposition,
  parseCsv,
  selectFinderResult,
};
