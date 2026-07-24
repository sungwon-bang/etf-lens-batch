# ETF Lens 전체 PDF 배치

매일 23:30 KST에 KRX 전체 ETF 목록을 API로 조회하고, 로그인 후 각 ETF의 PDF 구성종목을 수집합니다.

## 실행 흐름

1. KRX API에서 최신 영업일과 전체 ETF 목록 조회
2. KRX 로그인 세션 생성
3. 아직 수집되지 않은 ETF만 이어서 수집
4. 25개마다 `data/etf-compositions.json` 중간 커밋
5. 세션이 20분 지나거나 수집이 실패하면 자동 재로그인
6. 실패 종목만 최대 2회 추가 재시도
7. 최종 상태를 `completed` 또는 `partial`로 저장

예약 실행뿐 아니라 GitHub Actions의 `Run workflow`로 수동 실행할 수 있습니다. 같은 기준일의 중간 결과가 있으면 완료된 ETF는 건너뛰고 이어서 실행합니다.

## 필요한 GitHub Secrets

- `KRX_API_KEY`: 전체 ETF 목록 조회
- `KRX_LOGIN_ID`: PDF 화면 로그인
- `KRX_LOGIN_PASSWORD`: PDF 화면 로그인

`ETF_SITE_URL`과 `ETF_SITE_TOKEN`은 사용하지 않습니다.

## 결과 파일

`data/etf-compositions.json`

```json
{
  "meta": {
    "date": "20260724",
    "total": 0,
    "completed": 0,
    "failed": 0,
    "status": "running",
    "updatedAt": ""
  },
  "items": {
    "449450": {
      "etf": {
        "code": "449450",
        "name": "PLUS K방산",
        "date": "20260724"
      },
      "summary": {
        "totalComponents": 0,
        "totalWeight": 0
      },
      "components": [],
      "collectedAt": ""
    }
  },
  "failures": {}
}
```

홈페이지의 시세·NAV·개별종목 등락률은 이 파일에 저장하지 않고 조회 시 KRX API에서 가져옵니다.
