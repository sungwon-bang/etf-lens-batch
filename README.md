# ETF Lens 전체 PDF 배치

매일 23:30 KST에 한국 내 Windows self-hosted runner에서 KRX 전체 ETF 목록을 API로 조회하고, 로그인 후 각 ETF의 PDF 구성종목을 수집합니다.

## 실행 환경

KRX가 GitHub 호스팅 서버에서 `Service unavailable`을 반환하므로 이 워크플로는 다음 라벨의 self-hosted runner만 사용합니다.

- `self-hosted`
- `Windows`
- `X64`

runner PC는 실행 시간 동안 전원이 켜져 있고 절전 모드가 해제되어 있어야 합니다. runner를 Windows 서비스로 설치하면 로그인하지 않은 상태에서도 예약 실행을 받을 수 있습니다.

## 실행 흐름

1. Windows runner에서 KRX 접속 가능 여부 확인
2. KRX API에서 최신 영업일과 전체 ETF 목록 조회
3. KRX 로그인 세션 생성
4. 아직 수집되지 않은 ETF만 이어서 수집
5. 25개마다 `data/etf-compositions.json` 중간 커밋
6. 세션이 20분 지나거나 수집이 실패하면 자동 재로그인
7. 실패 종목만 최대 2회 추가 재시도
8. 최종 상태를 `completed` 또는 `partial`로 저장

예약 실행뿐 아니라 GitHub Actions의 `Run workflow`로 수동 실행할 수 있습니다. 같은 기준일의 중간 결과가 있으면 완료된 ETF는 건너뛰고 이어서 실행합니다.

## 최초 runner 연결

GitHub 저장소에서 `Settings → Actions → Runners → New self-hosted runner`를 열고 `Windows`, `x64`를 선택합니다. 화면에 표시되는 PowerShell 명령을 runner로 사용할 Windows PC에서 차례로 실행합니다.

설정 질문에는 다음처럼 답합니다.

- runner group: 기본값
- runner name: `etf-lens-windows`
- additional labels: 입력 없이 Enter
- work folder: 기본값
- service install: `Y`
- service account: 기본값

등록 후 Runners 화면에서 상태가 `Idle`이면 준비가 끝난 것입니다.

## 필요한 GitHub Secrets

- `KRX_API_KEY`: 전체 ETF 목록 조회
- `KRX_LOGIN_ID`: PDF 화면 로그인
- `KRX_LOGIN_PASSWORD`: PDF 화면 로그인

`ETF_SITE_URL`과 `ETF_SITE_TOKEN`은 사용하지 않습니다.

## 첫 검증 순서

1. Actions에서 `ETF PDF 야간 전체 수집` 선택
2. `Run workflow`의 `login_only` 실행
3. 성공하면 `collect` 실행
4. `data/etf-compositions.json`의 `meta.status`가 `completed`인지 확인

실패하면 `krx-diagnostics-...` 아티팩트에 HTML·스크린샷·화면 요소 목록이 저장됩니다.

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

## 홈페이지 데이터 결합 구조

### 1. 사용자가 ETF 검색

예: `449450 PLUS K방산`

홈페이지가 서버 API를 호출합니다.

```http
GET /api/market-data
```

이 API가 조회 시점에 KRX API를 호출해 다음 데이터를 가져옵니다.

- ETF 종가
- ETF 전일 대비
- ETF 일간 수익률
- ETF NAV
- KOSPI·KOSDAQ·KONEX 개별주식 수익률

현재 실제 응답에서도 데이터 출처가 `krx-api-live`로 표시되고 있습니다.

- ETF 1,150개
- 개별주식 2,872개
- PLUS K방산 수익률 `-1.67%`
- 개별주식 API 3개 시장 모두 정상

이 데이터는 별도의 `stock-returns.json`으로 저장하지 않고, 사용자가 검색할 때 서버에서 KRX API를 호출해 메모리에서 사용하는 방식입니다.

단, 여기서 “실시간”은 현재 MVP 기준으로 장중 실시간 체결가가 아니라 KRX에 등록된 최신 장 마감 데이터입니다.

### 2. PDF 구성비중은 미리 수집된 JSON 사용

PDF 수집기가 미리 KRX PDF를 내려받아 다음과 같은 구조로 저장합니다.

```json
{
  "etf": {
    "code": "449450",
    "name": "PLUS K방산",
    "date": "20260724"
  },
  "components": [
    {
      "code": "012450",
      "name": "한화에어로스페이스",
      "weight": 20.91
    }
  ]
}
```

기존 CSV 파서도 구성종목 코드·종목명·평가금액·시가총액·구성비중까지만 생성합니다.

기존 수집기는 이 JSON을 홈페이지의 `/api/pdf`로 업로드하도록 만들어져 있습니다.

홈페이지에서는 검색한 ETF에 대해 다음 API로 저장된 PDF 데이터를 조회합니다.

```http
GET /api/batch-data?code=449450&date=20260724
```

현재 449450은 구성종목 11개, 구성비중 약 100%를 정상 반환합니다.

### 3. 실시간 수익률과 저장된 구성비중 결합

각 종목의 기여도는 다음 방식으로 계산합니다.

```text
종목 기여도
= PDF 구성비중 × KRX 개별주식 수익률 ÷ 100
```

예를 들어 한화에어로스페이스는 다음과 같습니다.

```text
구성비중: 20.91%
개별주식 수익률: +2.19%

기여도 = 20.91 × 2.19 ÷ 100
       = 약 +0.458%p
```

최종적으로 구성종목 기여도 합계를 계산합니다.

```text
구성종목 기여도 합계
= 각 구성종목 기여도의 합계
```

ETF 수익률과 구성종목 기여도 합계의 차이는 잔차로 표시합니다.
