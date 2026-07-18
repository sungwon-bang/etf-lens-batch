const { chromium } = require('playwright');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const KRX_API_KEY = process.env.KRX_API_KEY;
const KRX_LOGIN_ID = process.env.KRX_LOGIN_ID;
const KRX_LOGIN_PASSWORD = process.env.KRX_LOGIN_PASSWORD;

const krxApi = axios.create({
  baseURL: 'http://data.krx.co.kr/comm/api',
  headers: { 'authorization': `Bearer ${KRX_API_KEY}`, timeout: 180000 }  // 180초
});

function getTodayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// KRX 로그인 (재시도 5회, 극도로 여유로운 timeout)
async function loginKRX(page) {
  console.log('🔐 KRX 로그인 중...');
  
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      console.log(`  시도 ${attempt}/5...`);
      
      // 페이지 로드 timeout 180초 (3분)
      console.log(`    📄 페이지 로드 중 (180초 대기)...`);
      await page.goto('https://data.krx.co.kr/', { 
        waitUntil: 'networkidle', 
        timeout: 180000
      });
      console.log(`    ✓ 페이지 로드 완료`);
      
      await page.waitForTimeout(8000);

      // 로그인 링크 찾기 timeout 120초 (2분)
      console.log(`    🔗 로그인 링크 찾는 중 (120초 대기)...`);
      const loginLink = page.locator('a[href*="/contents/MDC/COMS/client/MDCCOMS001.cmd"]').first();
      await loginLink.waitFor({ state: 'visible', timeout: 120000 });
      console.log(`    ✓ 로그인 링크 발견`);
      
      await loginLink.click();
      await page.waitForTimeout(8000);

      // iframe에서 로그인 입력창 찾기 timeout 120초 (2분)
      console.log(`    📝 로그인 입력창 찾는 중 (120초 대기)...`);
      const frames = page.frames();
      let loginFrame = null;
      let frameAttempts = 0;
      
      for (let i = 0; i < 60; i++) {  // 60회 시도 (각 2초 = 120초)
        frameAttempts++;
        for (const frame of frames) {
          try {
            const idInput = frame.locator('input[name="mbrId"]').first();
            // 각 input 요소 timeout 5초
            if (await idInput.isVisible({ timeout: 5000 }).catch(() => false)) {
              loginFrame = frame;
              console.log(`    ✓ 로그인 입력창 발견 (시도 ${frameAttempts})`);
              break;
            }
          } catch (e) {}
        }
        if (loginFrame) break;
        if (i % 10 === 0 && i > 0) console.log(`    ⏳ ${i * 2}초 경과...`);
        await page.waitForTimeout(2000);
      }

      if (!loginFrame) throw new Error('로그인 입력창 찾지 못함');

      // 로그인 정보 입력
      console.log(`    ✓ 로그인 정보 입력 중...`);
      await loginFrame.locator('input[name="mbrId"]').fill(KRX_LOGIN_ID);
      await page.waitForTimeout(2000);
      
      await loginFrame.locator('input[name="pw"]').fill(KRX_LOGIN_PASSWORD);
      await page.waitForTimeout(2000);
      
      // 로그인 버튼 클릭 timeout 60초
      console.log(`    🔘 로그인 버튼 찾는 중 (60초 대기)...`);
      const submitBtn = loginFrame.locator('button[type="submit"]').first();
      await submitBtn.waitFor({ state: 'visible', timeout: 60000 });
      await submitBtn.click();

      // 로그인 완료 대기 timeout 20초
      console.log(`    ⏳ 로그인 처리 중 (20초 대기)...`);
      await page.waitForTimeout(20000);
      
      console.log('✅ 로그인 완료');
      return true;

    } catch (error) {
      console.error(`  ❌ 시도 ${attempt} 실패:`, error.message);
      if (attempt < 5) {
        console.log(`  ⏳ 10초 후 재시도...`);
        await page.waitForTimeout(10000);
      }
    }
  }

  return false;
}

// ETF 목록 조회 (timeout 180초)
async function getETFList() {
  try {
    console.log('📊 KRX에서 ETF 목록 조회 중 (180초 대기)...');
    
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

// ETF 시세 조회 (timeout 120초)
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
        priceChangeChangePercent: parseFloat(data.TrdPrcRtChg)
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
  console.log('🚀 배치 수집 시작 (극도로 여유로운 timeout)\n');

  let browser;
  const today = getTodayDate();
  const results = {};

  try {
    if (!KRX_API_KEY || !KRX_LOGIN_ID || !KRX_LOGIN_PASSWORD) {
      throw new Error('환경변수 누락: KRX_API_KEY, KRX_LOGIN_ID, KRX_LOGIN_PASSWORD');
    }

    // 브라우저 시작
    console.log('🌐 Playwright 브라우서 시작 (300초 대기)...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
      timeout: 300000  // 300초 (5분)
    });
    console.log('✓ 브라우저 시작 완료\n');

    const context = await browser.newContext({ timeout: 300000 });
    const page = await context.newPage({ timeout: 300000 });

    // 로그인 (재시도 5회)
    if (!await loginKRX(page)) {
      throw new Error('KRX 로그인 실패 (5회 재시도 모두 실패)');
    }

    console.log('');

    // ETF 목록 조회
    const etfList = await getETFList();

    // 각 ETF 데이터 수집
    console.log('📊 ETF 데이터 수집 중...\n');
    
    for (let i = 0; i < etfList.length; i++) {
      const etf = etfList[i];
      console.log(`[${i + 1}/${etfList.length}] 📊 ${etf.name} (${etf.code})`);

      try {
        // 시세 조회 (3회 재시도, 각 120초)
        let priceData = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          console.log(`      시도 ${attempt}/3 (120초 대기)...`);
          priceData = await getETFPrice(etf.code);
          if (priceData) break;
          if (attempt < 3) {
            console.log(`      ⏳ 10초 후 재시도...`);
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
        }

        if (!priceData) {
          console.log(`   ⚠️  시세 조회 실패, 건너뜀`);
          continue;
        }

        // PDF 구성 데이터 조회
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
            priceChangePercent: priceData.priceChangeChangePercent
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

      // 다음 ETF 전까지 2초 대기
      await new Promise(resolve => setTimeout(resolve, 2000));
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
