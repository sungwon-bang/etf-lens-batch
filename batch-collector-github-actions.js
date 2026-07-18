const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const KRX_API_KEY = process.env.KRX_API_KEY;
const KRX_LOGIN_ID = process.env.KRX_LOGIN_ID;
const KRX_LOGIN_PASSWORD = process.env.KRX_LOGIN_PASSWORD;

const krxApi = axios.create({
  baseURL: 'http://data.krx.co.kr/comm/api',
  headers: { 'authorization': `Bearer ${KRX_API_KEY}` }
});

function getTodayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// KRX 로그인
async function loginKRX(page) {
  console.log('🔐 KRX 로그인 중...');
  
  try {
    await page.goto('https://data.krx.co.kr/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const loginLink = page.locator('a[href*="/contents/MDC/COMS/client/MDCCOMS001.cmd"]').first();
    await loginLink.waitFor({ state: 'visible', timeout: 15000 });
    await loginLink.click();
    await page.waitForTimeout(3000);

    // iframe에서 로그인
    const frames = page.frames();
    let loginFrame = null;
    
    for (const frame of frames) {
      const idInput = frame.locator('input[name="mbrId"]').first();
      if (await idInput.isVisible({ timeout: 300 }).catch(() => false)) {
        loginFrame = frame;
        break;
      }
    }

    if (!loginFrame) throw new Error('로그인 입력창 찾지 못함');

    await loginFrame.locator('input[name="mbrId"]').fill(KRX_LOGIN_ID);
    await loginFrame.locator('input[name="pw"]').fill(KRX_LOGIN_PASSWORD);
    await loginFrame.locator('button[type="submit"]').click();

    await page.waitForTimeout(5000);
    console.log('✅ 로그인 완료');
    return true;

  } catch (error) {
    console.error('❌ 로그인 실패:', error.message);
    return false;
  }
}

// ETF 목록 조회
async function getETFList() {
  try {
    console.log('📊 KRX에서 ETF 목록 조회 중...');
    
    const response = await krxApi.get('/etfInvstGuideDtl', {
      params: { isuCd: '', pageNumber: 1, pageSize: 500 }
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
    { code: '405060', name: 'TIGER 200' }
  ];
}

// ETF 시세 조회
async function getETFPrice(etfCode) {
  try {
    const response = await krxApi.get('/staticsData/equityPrice', {
      params: { isuCd: etfCode, isuCdvd: 'D' }
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

// PDF에서 구성 데이터 추출 (실제 구현 필요)
async function getETFCompositionFromPDF(page, etfCode, etfName) {
  // 실제 구현: KRX PDF 페이지 접속 → 테이블 추출
  // 현재는 모의 데이터 반환
  const mockData = {
    '449450': [
      { code: '012450', name: '한화에어로스페이스', weight: 20.68, stockReturn: 1.51 }
    ]
  };
  return mockData[etfCode] || [];
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

    // 브라우저 시작 (headless 모드)
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext();
    const page = await context.newPage();

    // 로그인
    if (!await loginKRX(page)) {
      throw new Error('KRX 로그인 실패');
    }

    // ETF 목록 조회
    const etfList = await getETFList();

    // 각 ETF 데이터 수집 (병렬 처리로 시간 단축)
    console.log('📊 ETF 데이터 수집 중...\n');
    
    for (const etf of etfList.slice(0, 50)) { // 테스트: 처음 50개만
      console.log(`📊 ${etf.name} (${etf.code})`);

      try {
        const priceData = await getETFPrice(etf.code);
        if (!priceData) {
          console.log(`   ⚠️  시세 조회 실패`);
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

      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // 결과 저장
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
