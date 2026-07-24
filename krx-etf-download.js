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

async function downloadComposition(context, { code, date }) {
  const page = await context.newPage();
  try {
    await page.goto(COMPOSITION_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const finderButton = page.locator(
      '[id^="btnisuCd_finder_secuprodisu1_"]:visible',
    ).first();
    await finderButton.waitFor({ state: 'visible', timeout: 30_000 });
    await finderButton.click();

    const search = page.locator(
      '[id^="searchText__finder_secuprodisu1_"]:visible',
    ).first();
    await search.waitFor({ state: 'visible', timeout: 15_000 });
    await search.fill(code);
    await search.press('Enter');
    await page.waitForTimeout(1_500);
    const finderLayer = page.locator('[id^="jsLayer_finder_secuprodisu1_"]:visible').last();
    const result = finderLayer.getByText(code, { exact: false }).last();
    if (!(await result.isVisible().catch(() => false))) throw new Error('ETF 검색 결과가 없습니다.');
    await result.click();

    const dateInput = page.locator('input[id*="trdDd"], input[name*="trdDd"], input[id*="basDd"], input[name*="basDd"]').first();
    if (await dateInput.isVisible().catch(() => false)) {
      await dateInput.fill(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`);
    }
    await page.locator('#jsSearchButton').click({ timeout: 15_000 });
    await page.waitForTimeout(3_000);
    await page.locator('img[title*="다운로드"]').first().click({ timeout: 15_000 });
    const downloadPromise = page.waitForEvent('download', { timeout: 45_000 });
    await page.locator('a').filter({ hasText: 'CSV' }).last().click({ timeout: 15_000 });
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
  } finally {
    await page.close();
  }
}

module.exports = {
  COMPOSITION_MENU_ID,
  COMPOSITION_URL,
  downloadComposition,
  parseCsv,
};
