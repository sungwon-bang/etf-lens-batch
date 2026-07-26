# ETF Lens 오프닝 페이지 적용 가이드

## 목표

홈페이지 최초 진입 시 특정 ETF 분석 화면을 바로 보여주지 않고 다음 내용을 표시합니다.

1. ETF Lens 소개 및 사용법
2. 거래량 상위 ETF 10개
3. 상승률 상위 ETF 10개

상단 검색창 또는 순위 목록에서 ETF를 선택하면 기존 ETF 기여도 분석 화면으로 전환합니다.

## 프론트 상태 변경

기존 앱이 특정 ETF를 기본 선택하고 있다면 초기 선택값을 `null`로 변경합니다.

```jsx
const [selectedEtf, setSelectedEtf] = useState(null);
const [searchText, setSearchText] = useState('');
```

페이지 본문은 다음처럼 분기합니다.

```jsx
{selectedEtf ? (
  <EtfAnalysis selectedEtf={selectedEtf} />
) : (
  <OpeningPage onSelectEtf={setSelectedEtf} />
)}
```

상단 로고를 누르면 오프닝 페이지로 돌아가도록 처리합니다.

```jsx
<a
  className="brand"
  href="#top"
  onClick={(event) => {
    event.preventDefault();
    setSelectedEtf(null);
    setSearchText('');
  }}
>
  ETF Lens
</a>
```

검색 결과 또는 오프닝 페이지의 ETF 행을 선택하면 기존 분석 화면을 엽니다.

```jsx
function selectEtf(etf) {
  setSelectedEtf({ code: etf.code, name: etf.name });
  setSearchText(etf.name);
}
```

## `/api/market-data` 필수 응답 필드

상승률 순위는 현재 `returnRate` 필드로 계산할 수 있습니다.

거래량 순위를 위해 ETF 객체에 `volume` 필드가 반드시 포함돼야 합니다.

```json
{
  "meta": {
    "source": "krx-api-live",
    "asOf": "2026-07-24"
  },
  "etfs": {
    "449450": {
      "code": "449450",
      "name": "PLUS K방산",
      "close": 55175,
      "change": -935,
      "returnRate": -1.67,
      "nav": 55488.37,
      "volume": 1234567
    }
  }
}
```

KRX ETF 일별 시세 응답을 정규화할 때 거래량 필드를 함께 전달합니다.

```js
const volume = toNumber(
  row.ACC_TRDVOL ??
  row.TDD_TRDVOL ??
  row.ACC_TRD_VOL
);

etfs[code] = {
  code,
  name,
  close,
  change,
  returnRate,
  nav,
  volume,
};
```

## 순위 계산

```js
const topVolume = Object.values(marketData.etfs)
  .filter((etf) => Number.isFinite(etf.volume))
  .sort((a, b) => b.volume - a.volume)
  .slice(0, 10);

const topGainers = Object.values(marketData.etfs)
  .filter((etf) => Number.isFinite(etf.returnRate))
  .sort((a, b) => b.returnRate - a.returnRate)
  .slice(0, 10);
```

순위 기준은 모두 `/api/market-data`가 반환한 최신 KRX 장 마감 기준일과 동일하게 유지합니다.

## 포함 파일

- `OpeningPage.jsx`: 데이터 조회, 소개 영역, 사용법, ETF 순위 목록
- `opening-page.css`: 데스크톱 및 모바일 반응형 스타일

현재 저장소에는 배치 수집 코드만 있고 실제 배포 홈페이지의 React 원본 소스는 없습니다. 실제 홈페이지 저장소에서 위 두 파일을 추가하고 기존 앱의 초기 선택 상태를 `null`로 변경해야 배포에 반영됩니다.
