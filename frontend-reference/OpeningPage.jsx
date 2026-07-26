import { useEffect, useMemo, useState } from 'react';
import './opening-page.css';

const numberFormatter = new Intl.NumberFormat('ko-KR');

function getVolume(etf) {
  const candidates = [
    etf?.volume,
    etf?.tradingVolume,
    etf?.tradeVolume,
    etf?.accTradeVolume,
    etf?.ACC_TRDVOL,
    etf?.TDD_TRDVOL,
  ];

  for (const candidate of candidates) {
    const value = Number(String(candidate ?? '').replaceAll(',', '').trim());
    if (Number.isFinite(value)) return value;
  }

  return null;
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function RankingTable({ title, description, items, valueLabel, renderValue, onSelectEtf }) {
  return (
    <section className="opening-ranking-card">
      <div className="opening-ranking-heading">
        <div>
          <span className="opening-ranking-kicker">LATEST KRX CLOSE</span>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
        <span className="opening-ranking-count">TOP 10</span>
      </div>

      <div className="opening-ranking-table" role="table" aria-label={title}>
        <div className="opening-ranking-row opening-ranking-header" role="row">
          <span>순위</span>
          <span>ETF</span>
          <span>{valueLabel}</span>
        </div>

        {items.map((etf, index) => (
          <button
            className="opening-ranking-row opening-ranking-item"
            type="button"
            role="row"
            key={etf.code}
            onClick={() => onSelectEtf?.({ code: etf.code, name: etf.name })}
          >
            <span className="opening-rank-number">{index + 1}</span>
            <span className="opening-etf-name">
              <strong>{etf.name}</strong>
              <small>{etf.code}</small>
            </span>
            <span className={Number(etf.returnRate) >= 0 ? 'opening-positive' : 'opening-negative'}>
              {renderValue(etf)}
            </span>
          </button>
        ))}

        {!items.length && (
          <div className="opening-ranking-empty">
            표시할 데이터가 없습니다. `/api/market-data` 응답 필드를 확인해 주세요.
          </div>
        )}
      </div>
    </section>
  );
}

export default function OpeningPage({ onSelectEtf }) {
  const [marketData, setMarketData] = useState(null);
  const [status, setStatus] = useState('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;

    async function loadMarketData() {
      setStatus('loading');
      setError('');

      try {
        const response = await fetch('/api/market-data', {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`시장 데이터 조회 실패 (${response.status})`);
        const payload = await response.json();
        if (!cancelled) {
          setMarketData(payload);
          setStatus('ready');
        }
      } catch (loadError) {
        if (!cancelled) {
          setStatus('failed');
          setError(loadError instanceof Error ? loadError.message : '시장 데이터를 불러오지 못했습니다.');
        }
      }
    }

    loadMarketData();
    return () => {
      cancelled = true;
    };
  }, []);

  const etfs = useMemo(() => Object.values(marketData?.etfs ?? {}), [marketData]);

  const topVolume = useMemo(() => (
    etfs
      .map((etf) => ({ ...etf, normalizedVolume: getVolume(etf) }))
      .filter((etf) => etf.normalizedVolume !== null)
      .sort((a, b) => b.normalizedVolume - a.normalizedVolume)
      .slice(0, 10)
  ), [etfs]);

  const topGainers = useMemo(() => (
    etfs
      .filter((etf) => Number.isFinite(Number(etf.returnRate)))
      .sort((a, b) => Number(b.returnRate) - Number(a.returnRate))
      .slice(0, 10)
  ), [etfs]);

  const asOf = marketData?.meta?.asOf?.replaceAll('-', '.') ?? '';

  return (
    <main className="opening-page">
      <section className="opening-hero">
        <div className="opening-hero-copy">
          <span className="opening-eyebrow">ETF RETURN ATTRIBUTION</span>
          <h1>ETF의 오늘 수익률을<br />구성종목별로 나눠보세요.</h1>
          <p>
            ETF Lens는 최신 KRX 장 마감 시세와 미리 수집한 PDF 구성비중을 결합해,
            개별 종목이 ETF 수익률에 얼마나 기여했는지 보여줍니다.
          </p>
          <div className="opening-data-badge">
            <span className="opening-live-dot" />
            {asOf ? `${asOf} 장 마감 기준` : '최신 KRX 데이터 조회 중'}
          </div>
        </div>

        <div className="opening-guide" aria-label="ETF Lens 사용법">
          <span className="opening-guide-title">사용 방법</span>
          <ol>
            <li>
              <strong>ETF 검색</strong>
              <span>상단 검색창에서 ETF명 또는 티커를 입력합니다.</span>
            </li>
            <li>
              <strong>구성종목 확인</strong>
              <span>저장된 PDF 구성비중을 기준으로 주요 종목을 확인합니다.</span>
            </li>
            <li>
              <strong>기여도 분석</strong>
              <span>KRX 개별주식 수익률과 구성비중을 결합한 기여도를 확인합니다.</span>
            </li>
          </ol>
        </div>
      </section>

      {status === 'loading' && (
        <div className="opening-status">최신 ETF 시장 데이터를 불러오고 있습니다.</div>
      )}

      {status === 'failed' && (
        <div className="opening-status opening-status-error">{error}</div>
      )}

      {status === 'ready' && (
        <section className="opening-rankings" aria-label="ETF 시장 순위">
          <RankingTable
            title="거래량 상위 ETF"
            description="최신 장 마감 거래량이 많은 ETF 순위입니다."
            items={topVolume}
            valueLabel="거래량"
            renderValue={(etf) => numberFormatter.format(etf.normalizedVolume)}
            onSelectEtf={onSelectEtf}
          />

          <RankingTable
            title="상승률 상위 ETF"
            description="최신 장 마감 수익률이 높은 ETF 순위입니다."
            items={topGainers}
            valueLabel="상승률"
            renderValue={(etf) => formatPercent(etf.returnRate)}
            onSelectEtf={onSelectEtf}
          />
        </section>
      )}
    </main>
  );
}
