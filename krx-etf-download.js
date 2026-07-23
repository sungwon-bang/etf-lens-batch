const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const [code, date, name = ''] = process.argv.slice(2);
const siteUrl = process.env.ETF_SITE_URL?.replace(/\/$/, '');
const siteToken = process.env.ETF_SITE_TOKEN;

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

function number(value) {
  const parsed = Number(String(value || '').replaceAll(',', '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsv(file) {
  const text = new TextDecoder('euc-kr').decode(fs.readFileSync(file));
  const rows = csvRows(text);
  if (rows.length < 2) throw new Error('다운로드된 CSV가 비어 있습니다.');
  const header = rows[0].map((item) => item.replace(/^"|"$/g, '').trim());
  const find = (...candidates) => candidates.map((candidate) => header.findIndex((item) => item.includes(candidate))).find((index) => index >= 0) ?? -1;
  const codeIndex = find('종목코드');
  const nameIndex = find('구성종목명', '종목명');
  const quantityIndex = find('주식수', '계약수');
  const amountIndex = find('평가금액');
  const capIndex = find('시가총액');
  const weightIndex = find('구성비중', '비중');
  if (codeIndex < 0 || nameIndex < 0 || weightIndex < 0) throw new Error(`필수 CSV 열을 찾지 못했습니다: ${header.join(', ')}`);
  return rows.slice(1).map((row) => ({
    code: String(row[codeIndex] || '').trim().toUpperCase(),
    name: String(row[nameIndex] || '').trim(),
    quantity: quantityIndex >= 0 ? number(row[quantityIndex]) : 0,
    evaluationAmount: amountIndex >= 0 ? number(row[amountIndex]) : 0,
    marketCap: capIndex >= 0 ? number(row[capIndex]) : 0,
    weight: number(row[weightIndex]),
  })).filter((item) => item.code && item.name && item.weight > 0);
}

async function download() {
  if (!/^[0-9A-Z]{6}$/.test(code || '') || !/^\d{8}$/.test(date || '')) throw new Error('ETF 코드 또는 기준일이 올바르지 않습니다.');
  if (!fs.existsSync('krx-session.json')) throw new Error('KRX 세션 파일이 없습니다.');
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const context = await browser.newContext({ storageState: 'krx-session.json', acceptDownloads: true });
    const page = await context.newPage();
    await page.goto('https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.evaluate(() => document.querySelector('[data-menu-id="MDC0201020000"]')?.click());
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-menu-id="MDC0201020100"]')?.click());
    await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('[data-menu-id="MDC0201030108"]')?.click());
    await page.waitForTimeout(2_500);

    await page.locator('#btnisuCd_finder_secuprodisu1_0').click({ timeout: 10_000 });
    const search = page.locator('#searchText__finder_secuprodisu1_0');
    await search.fill(code);
    await search.press('Enter');
    await page.waitForTimeout(2_000);
    const result = page.getByText(code, { exact: false }).last();
    if (await result.isVisible().catch(() => false)) await result.click();

    const dateInput = page.locator('input[id*="trdDd"], input[name*="trdDd"], input[id*="basDd"], input[name*="basDd"]').first();
    if (await dateInput.isVisible().catch(() => false)) await dateInput.fill(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`);
    await page.locator('#jsSearchButton').click({ timeout: 10_000 });
    await page.waitForTimeout(4_000);

    const downloadButton = page.locator('img[title*="다운로드"]').first();
    await downloadButton.click({ timeout: 10_000 });
    const csv = page.locator('a').filter({ hasText: 'CSV' }).last();
    const downloadPromise = page.waitForEvent('download', { timeout: 45_000 });
    await csv.click({ timeout: 10_000 });
    const item = await downloadPromise;
    const file = path.join(process.cwd(), `krx-${code}-${date}.csv`);
    await item.saveAs(file);
    return file;
  } finally {
    await browser.close();
  }
}

async function upload(components) {
  if (!siteUrl || !siteToken) throw new Error('ETF_SITE_URL과 ETF_SITE_TOKEN이 필요합니다.');
  if (!components.length) throw new Error('구성종목이 0건입니다.');
  const payload = {
    etf: { code, name, date, parsingTime: new Date().toISOString() },
    summary: { totalComponents: components.length, totalWeight: components.reduce((sum, item) => sum + item.weight, 0), currency: 'KRW' },
    components,
  };
  const response = await fetch(`${siteUrl}/api/pdf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'OAI-Sites-Authorization': `Bearer ${siteToken}` },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(`홈페이지 업로드 실패 (${response.status}): ${await response.text()}`);
  console.log(`PDF 구성종목 업로드 완료: ${code} ${components.length}개`);
}

async function main() {
  const file = await download();
  try { await upload(parseCsv(file)); }
  finally { fs.rmSync(file, { force: true }); }
}

main().catch((error) => {
  console.error('PDF 수집 실패:', error.message);
  process.exitCode = 1;
});
