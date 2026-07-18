const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const KRX_API_KEY = process.env.KRX_API_KEY;

const krxApi = axios.create({
  baseURL: 'http://data.krx.co.kr/comm/api',
  headers: { 'authorization': `Bearer ${KRX_API_KEY}` },
  timeout: 30000
});

function getTodayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// 기본 ETF 목록 (고정)
function getETFList() {
  console.log('📊 ETF 목록 (고정)...\n');
  
  return [
    { code: '449450', name: 'PLUS K방산' },
    { code: '448140', name: 'SOL 코스닥150' },
    { code: '405060', name: 'TIGER 200' },
    { code: '102110', name: 'TIGER 200' },
    { code: '102780', name: 'KODEX 200' },
    { code: '139290', name: 'KODEX 반도체' }
  ];
}

// ETF 시세 조회 (재시도 2회)
async function getETFPrice(etfCode) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await krxApi.get('/staticsData/equityPrice', {
        params: { isuCd: etfCode, isuCdvd: 'D' },
        timeout: 30000
      });

      if (response.data?.OutBlock_1?.[0]) {
        const data = response.data.OutBlock_1[0];
        return {
          code: etfCode,
          price: parseFloat(data.TrdPrc) || 0,
          priceChange: parseFloat(data.TrdPrcChg) || 0,
          priceChangePercent: parseFloat(data.TrdPrcRtChg) || 0
        };
      }
    } catch (error) {
      if (attempt === 2) {
        console.error(`      ❌ 재시도 후에도 실패`);
      }
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }
  return null;
}

// 모의 구성 데이터
function getMockComposition(etfCode) {
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
}

function calculateContribution(weight, stockReturn) {
  return (weight / 100) * stockReturn;
}

// 메인
async function main() {
  console.log('🚀 배치 수집 시작\n');

  const today = getTodayDate();
  let results = {};

  try {
    if (!KRX_API_KEY) {
      throw new Error('환경변수 누락: KRX_API_KEY');
    }

    const etfList = getETFList();

    console.log('📊 ETF 데이터 수집 중...\n');
    
    for (let i = 0; i < etfList.length; i++) {
      const etf = etfList[i];
      console.log(`[${i + 1}/${etfList.length}] 📊 ${etf.name} (${etf.code})`);

      try {
        let priceData = await getETFPrice(etf.code);
        
        if (!priceData) {
          console.log(`   ⚠️  시세 조회 실패, 모의 데이터 사용`);
          priceData = { code: etf.code, price: 50000, priceChange: 0, priceChangePercent: 0 };
        }

        const components = getMockComposition(etf.code);
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

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    const filePath = 'etf-data.json';
    fs.writeFileSync(filePath, JSON.stringify(results, null, 2), 'utf-8');

    console.log(`\n✅ 데이터 저장 완료: ${filePath}`);
    console.log(`📊 ${Object.keys(results).length}개 ETF 수집됨\n`);

    process.exit(0);

  } catch (error) {
    console.error('\n❌ 배치 실패:', error.message);
    process.exit(1);
  }
}

main();