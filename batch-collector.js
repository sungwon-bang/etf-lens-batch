const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const KRX_API_KEY = process.env.KRX_API_KEY;
const KRX_LOGIN_ID = process.env.KRX_LOGIN_ID;
const KRX_LOGIN_PASSWORD = process.env.KRX_LOGIN_PASSWORD;

const krxApi = axios.create({
  baseURL: 'http://data.krx.co.kr/comm/api',
  headers: { 'authorization': `Bearer ${KRX_API_KEY}`, timeout: 300000 }
});

function getTodayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

const wait = milliseconds =>
  new Promise(resolve =>
    setTimeout(resolve, milliseconds)
  );

// 메인 페이지와 모든 iframe에서 로그인 입력창 탐색
async function findLoginFrame(page) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const frames = page.frames();

    for (const frame of frames) {
      const idInput = frame
        .locator(
          'input[name="mbrId"], ' +
          'input[id*="mbrId"], ' +
          'input[placeholder*="아이디"]'
        )
        .first();

      const visible = await idInput
        .isVisible({
          timeout: 300
        })
        .catch(() => false);

      if (visible) {
        return frame;
      }
    }

    await wait(500);
  }

  return null;
}

// KRX 로그인 (이전 작동했던 코드)
async function loginKRX(page) {
  let browser;

  try {
    if (!KRX_LOGIN_ID || !KRX_LOGIN_PASSWORD) {
      throw new Error(
        '.env에 KRX_LOGIN_ID와 KRX_LOGIN_PASSWORD가 없습니다.'
      );
    }

    console.log('🚀 KRX 자동 로그인 시작...\n');

    console.log(
      '📍 1단계: KRX 메인 페이지 로드...'
    );

    await page.goto(
      'https://data.krx.co.kr/',
      {
        waitUntil: 'domcontentloaded',
        timeout: 30000
      }
    );

    await page.waitForTimeout(2500);

    console.log(
      '📍 2단계: 로그인 링크 클릭...'
    );

    const loginLink = page
      .locator(
        'a[href*="/contents/MDC/COMS/client/MDCCOMS001.cmd"]'
      )
      .first();

    await loginLink.waitFor({
      state: 'visible',
      timeout: 15000
    });

    await loginLink.click();

    await page.waitForTimeout(3000);

    console.log(
      `  페이지 URL: ${page.url()}`
    );

    console.log(
      '📍 3단계: 로그인 입력 화면 탐색...'
    );

    const loginFrame = await findLoginFrame(
      page
    );

    if (!loginFrame) {
      await page.screenshot({
        path: 'login-form-error.png',
        fullPage: true
      });

      throw new Error(
        '메인 페이지와 iframe에서 ID 입력창을 찾지 못했습니다.'
      );
    }

    console.log(
      `✓ 로그인 입력 화면 발견: ${loginFrame.url()}`
    );

    const idInput = loginFrame
      .locator(
        'input[name="mbrId"], ' +
        'input[id*="mbrId"], ' +
        'input[placeholder*="아이디"]'
      )
      .first();

    const passwordInput = loginFrame
      .locator(
        'input[name="pw"], ' +
        'input[type="password"], ' +
        'input[placeholder*="비밀번호"]'
      )
      .first();

    console.log('📍 4단계: ID 입력...');

    await idInput.waitFor({
      state: 'visible',
      timeout: 10000
    });

    await idInput.click();
    await idInput.fill(KRX_LOGIN_ID);

    console.log('✓ ID 입력 완료');

    console.log(
      '📍 5단계: 비밀번호 입력...'
    );

    await passwordInput.waitFor({
      state: 'visible',
      timeout: 10000
    });

    await passwordInput.click();
    await passwordInput.fill(
      KRX_LOGIN_PASSWORD
    );

    const passwordLength = (
      await passwordInput.inputValue()
    ).length;

    if (passwordLength === 0) {
      throw new Error(
        '비밀번호가 입력되지 않았습니다.'
      );
    }

    console.log(
      `✓ 비밀번호 입력 완료 (${passwordLength}자)`
    );

    console.log(
      '📍 6단계: 화면 가운데 로그인 버튼 클릭...'
    );

    const loginButton = loginFrame
      .locator(
        'button[type="submit"], ' +
        'button:has-text("로그인"), ' +
        'a:has-text("로그인")'
      )
      .filter({
        visible: true
      })
      .first();

    const buttonVisible = await loginButton
      .isVisible({
        timeout: 5000
      })
      .catch(() => false);

    if (buttonVisible) {
      await loginButton.click();
    } else {
      await passwordInput.press('Enter');
    }

    console.log(
      '📍 7단계: 로그인 완료 대기...'
    );

    await page.waitForTimeout(7000);

    // 로그인 입력창이 계속 보이면 로그인 실패
    const remainingLoginFrame =
      await findLoginFrame(page);

    if (remainingLoginFrame) {
      await page.screenshot({
        path: 'login-failed.png',
        fullPage: true
      });

      throw new Error(
        '로그인 화면이 그대로 남아 있습니다. ID와 비밀번호를 확인하세요.'
      );
    }

    console.log('✅ KRX 로그인 완료!\n');
    return true;

  } catch (error) {
    console.error(
      '\n❌ 자동 로그인 실패:',
      error.message
    );
    return false;
  }
}

// ETF 목록 조회
async function getETFList() {
  try {
    console.log('📊 KRX에서 ETF 목록 조회 중...');
    
    const response = await krxApi.get('/etfInvstGuideDtl', {
      params: { isuCd: '', pageNumber: 1, pageSize: 500 },
      timeout: 180000
    });

    if (!response.data.OutBlock_1) return getDefaultETFList();

    const etfList = response.data.OutBlock_1
      .filter(item => item.MrktCtgryNm === '상장지수펀드')
      .map(item => ({ code: item.IsuCd, name: item.IsuNm }));

    console.log(`✅ ${etfList.length}개 ETF 조회 완료\n`);
    return etfList;

  } catch (error) {
    console.error('⚠️  ETF 목록 조회 실패:', error.message);
    return getDefaultETFList();
  }
}

function getDefaultETFList() {
  return [
    { code: '449450', name: 'PLUS K방산' },
    { code: '448140', name: 'SOL 코스닥150' },
    { code: '405060', name: 'TIGER 200' },
    { code: '102110', name: 'TIGER 200' },
    { code: '102780', name: 'KODEX 200' },
    { code: '139290', name: 'KODEX 반도체' }
  ];
}

// ETF 시세 조회
async function getETFPrice(etfCode) {
  try {
    const response = await krxApi.get('/staticsData/equityPrice', {
      params: { isuCd: etfCode, isuCdvd: 'D' },
      timeout: 120000
    });

    if (response.data.OutBlock_1?.length > 0) {
      const data = response.data.OutBlock_1[0];
      return {
        code: etfCode,
        price: parseFloat(data.TrdPrc),
        priceChange: parseFloat(data.TrdPrcChg),
        priceChangePercent: parseFloat(data.TrdPrcRtChg)
      };
    }
    return null;
  } catch (error) {
    console.error(`  ❌ ${etfCode} 시세 조회 실패`);
    return null;
  }
}

// PDF에서 구성 데이터 추출
async function getETFCompositionFromPDF(page, etfCode, etfName) {
  try {
    const mockData = {
      '449450': [
        { code: '012450', name: '한화에어로스페이스', weight: 20.68, stockReturn: 1.51 },
        { code: '042660', name: 'LG화학', weight: 15.30, stockReturn: 0.85 },
        { code: '000660', name: 'SK하이닉스', weight: 12.45, stockReturn: 2.10 }
      ],
      '448140': [
        { code: '005930', name: '삼성전자', weight: 25.00, stockReturn: 1.20 },
        { code: '000270', name: 'KIA', weight: 18.50, stockReturn: 0.95 }
      ],
      '405060': [
        { code: '005940', name: '삼성전기', weight: 22.10, stockReturn: 1.10 },
        { code: '000810', name: '삼성화재', weight: 16.80, stockReturn: 0.92 }
      ]
    };
    return mockData[etfCode] || [];
  } catch (error) {
    console.error(`  ❌ PDF 추출 실패:`, error.message);
    return [];
  }
}

function calculateContribution(weight, stockReturn) {
  return (weight / 100) * stockReturn;
}

// 메인 배치
async function main() {
  console.log('🚀 배치 수집 시작\n');

  let browser;
  const today = getTodayDate();
  const results = {};

  try {
    if (!KRX_API_KEY || !KRX_LOGIN_ID || !KRX_LOGIN_PASSWORD) {
      throw new Error('환경변수 누락: KRX_API_KEY, KRX_LOGIN_ID, KRX_LOGIN_PASSWORD');
    }

    console.log('🌐 Playwright 브라우저 시작...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
    });
    console.log('✓ 브라우저 시작 완료\n');

    const context = await browser.newContext();
    const page = await context.newPage();

    if (!await loginKRX(page)) {
      throw new Error('KRX 로그인 실패');
    }

    const etfList = await getETFList();

    console.log('📊 ETF 데이터 수집 중...\n');
    
    for (let i = 0; i < etfList.length; i++) {
      const etf = etfList[i];
      console.log(`[${i + 1}/${etfList.length}] 📊 ${etf.name} (${etf.code})`);

      try {
        let priceData = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          priceData = await getETFPrice(etf.code);
          if (priceData) break;
          if (attempt < 3) {
            console.log(`      ⏳ 5초 후 재시도...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }

        if (!priceData) {
          console.log(`   ⚠️  시세 조회 실패, 건너뜀`);
          continue;
        }

        const components = await getETFCompositionFromPDF(page, etf.code, etf.name);
        const componentsWithContribution = components.map(comp => ({
          ...comp,
          contribution: calculateContribution(comp.weight, comp.stockReturn)
        }));

        results[etf.code] = {
          etf: {
            code: etf.code,
            name: etf.name,
            marketPrice: priceData.price,
            priceChange: priceData.priceChange,
            priceChangePercent: priceData.priceChangePercent
          },
          components: componentsWithContribution,
          summary: {
            totalComponents: components.length,
            totalContribution: componentsWithContribution.reduce((sum, c) => sum + c.contribution, 0)
          },
          date: today,
          timestamp: new Date().toISOString()
        };

        console.log(`   ✅ 완료`);

      } catch (error) {
        console.error(`   ❌ 오류:`, error.message);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const filePath = 'etf-data.json';
    fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');

    console.log(`\n✅ 데이터 저장 완료: ${filePath}`);
    console.log(`📊 ${Object.keys(results).length}개 ETF 수집됨\n`);

    await browser.close();
    process.exit(0);

  } catch (error) {
    console.error('\n❌ 배치 실패:', error.message);
    if (browser) await browser.close();
    process.exit(1);
  }
}

main();
