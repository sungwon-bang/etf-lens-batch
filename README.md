# 🚀 ETF Lens 배치 수집기

ETF 기여도 분석 배치 수집 시스템

## 📋 개요

```
매일 자동 실행
  ↓
ETF 데이터 수집
  ↓
etf-data.json 저장
  ↓
홈페이지에서 사용
```

## ✨ 특징

- ✅ 완전 무료 (GitHub Actions)
- ✅ 복잡한 설정 없음
- ✅ 매일 자동 갱신
- ✅ 100% 안정적

## 📝 설정

### 1. GitHub Secrets 추가

Settings → Secrets → New repository secret

```
KRX_API_KEY
KRX_LOGIN_ID
KRX_LOGIN_PASSWORD
```

### 2. 로컬 테스트

```bash
npm install
npm run collect
```

### 3. 자동 실행

매일 자정(UTC)에 자동 실행
(수동 실행: GitHub Actions → Run workflow)

## 📊 데이터 형식

`etf-data.json`:
```json
{
  "449450": {
    "etf": {
      "code": "449450",
      "name": "PLUS K방산",
      "marketPrice": 54240
    },
    "components": [...]
  }
}
```

## 🌐 홈페이지 사용

```javascript
const response = await fetch(
  'https://raw.githubusercontent.com/USERNAME/etf-lens-batch/main/etf-data.json'
);
const data = await response.json();
```

## 📄 라이선스

MIT
