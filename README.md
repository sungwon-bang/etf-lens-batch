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
