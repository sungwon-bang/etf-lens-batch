const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const KRX_API_KEY = process.env.KRX_API_KEY;
const KRX_LOGIN_ID = process.env.KRX_LOGIN_ID;
const KRX_LOGIN_PASSWORD = process.env.KRX_LOGIN_PASSWORD;

// KRX API 기본 설정
const krxApi = axios.create({
  baseURL: 'http://data.krx.co.kr/comm/api',
  headers: {
    'authorization': `Bearer ${KRX_API_KEY}`
  }
});

// ETF 목록 (상장 현물형만)
const ETF_LIST = [
  { code: '449450', name: 'PLUS K방산' },
  { code: '448140', name: 'SOL 코스닥150' },
  { code: '405060', name: 'TIGER 200' },
  { code: '102110', name: 'TIGER 200' },
  { code: '102780', name: 'KODEX 200' },
];

// 오늘 날짜 (YYYYMMDD 형식)
function getTodayDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

// KRX에서 ETF 시세 조회
async function getETFPrice(etfCode) {
  try {
    const response = await krxApi.get('/staticsData/equityPrice', {
      params: {
        isuCd: etfCode,
        isuCdvd: 'D'
      }
    });

    if (response.data.OutBlock_1 && response.data.OutBlock_1.length > 0) {
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
    console.error(`❌ ETF ${etfCode} 시세 조회 실패:`, error.message);
    return null;
  }
}

// 모의 데이터 생성 (실제로는 PDF에서 가져와야 함)
async function getETFComposition(etfCode, etfName) {
  const mockData = {
    '449450': [
      { code: '012450', name: '한화에어로스페이스', weight: 20.68, stockReturn: 1.51 },
      { code: '042660', name: 'LG화학', weight: 15.30, stockReturn: 0.85 },
      { code: '000660', name: 'SK하이닉스', weight: 12.45, stockReturn: 2.10 }
    ],
    '448140': [
      { code: '005930', name: '삼성전자', weight: 25.00, stockReturn: 1.20 },
      { code: '000270', name: 'KIA', weight: 18.50, stockReturn: 0.95 },
      { code: '006400', name: '삼성SDI', weight: 14.30, stockReturn: 1.45 }
    ]
  };

  return mockData[etfCode] || [];
}

// 기여도 계산
function calculateContribution(weight, stockReturn) {
  return (weight / 100) * stockReturn;
}

// 모든 ETF 데이터 수집
async function collectAllETFData() {
  console.log('🚀 배치 수집 시작...\n');

  const today = getTodayDate();
  const results = {};

  for (const etf of ETF_LIST) {
    console.log(`📊 ${etf.name} (${etf.code}) 수집 중...`);

    try {
      const priceData = await getETFPrice(etf.code);
      if (!priceData) {
        console.log(`   ⚠️  시세 조회 실패, 건너뜀`);
        continue;
      }

      const components = await getETFComposition(etf.code, etf.name);

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

  return results;
}

// JSON 파일 저장
async function saveToJSON(data) {
  try {
    const filePath = 'etf-data.json';
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`\n✅ 데이터 저장 완료: ${filePath}`);
    console.log(`📊 ${Object.keys(data).length}개 ETF 데이터`);
    return true;
  } catch (error) {
    console.error('❌ 파일 저장 실패:', error.message);
    return false;
  }
}

// 메인 실행
async function main() {
  try {
    if (!KRX_API_KEY) {
      throw new Error('.env에 KRX_API_KEY가 없습니다.');
    }

    const data = await collectAllETFData();
    
    if (Object.keys(data).length === 0) {
      throw new Error('수집된 데이터가 없습니다.');
    }

    await saveToJSON(data);
    
    console.log('\n🎉 배치 수집 완료!\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ 배치 수집 실패:', error.message);
    process.exit(1);
  }
}

main();
