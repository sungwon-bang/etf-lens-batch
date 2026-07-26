const fs = require('fs');
const path = require('path');

const SITE_URL = (process.env.ETF_SITE_URL || 'https://etf-attribution-mvp.bang-starone.chatgpt.site').replace(/\/$/, '');
const OUTPUT_PATH = path.join(__dirname, 'data', 'site-diagnostics', 'opening-page-data.json');

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? '').replaceAll(',', '').replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function pickVolume(item) {
  const candidates = [
    'volume', 'tradingVolume', 'tradeVolume', 'accTradeVolume', 'accTrdvol',
    'ACC_TRDVOL', 'ACC_TRD_VOL', 'TDD_TRDVOL', 'trdVolume', '거래량',
  ];
  for (const key of candidates) {
    const value = toNumber(item?.[key]);
    if (value !== null) return { key, value };
  }
  return { key: null, value: null };
}

async function main() {
  const response = await fetch(`${SITE_URL}/api/market-data`, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`market-data 실패 ${response.status}: ${text.slice(0, 500)}`);
  const market = JSON.parse(text);
  const etfs = Object.values(market.etfs || {});

  const keyCounts = {};
  const numericKeyCounts = {};
  for (const item of etfs) {
    for (const [key, value] of Object.entries(item || {})) {
      keyCounts[key] = (keyCounts[key] || 0) + 1;
      if (toNumber(value) !== null) numericKeyCounts[key] = (numericKeyCounts[key] || 0) + 1;
    }
  }

  const volumeRows = etfs
    .map((item) => ({ ...item, _volume: pickVolume(item) }))
    .filter((item) => item._volume.value !== null)
    .sort((a, b) => b._volume.value - a._volume.value)
    .slice(0, 10)
    .map((item) => ({
      code: item.code,
      name: item.name,
      volume: item._volume.value,
      volumeField: item._volume.key,
      returnRate: toNumber(item.returnRate),
      close: toNumber(item.close),
    }));

  const gainers = etfs
    .filter((item) => toNumber(item.returnRate) !== null)
    .sort((a, b) => toNumber(b.returnRate) - toNumber(a.returnRate))
    .slice(0, 10)
    .map((item) => ({
      code: item.code,
      name: item.name,
      returnRate: toNumber(item.returnRate),
      close: toNumber(item.close),
      change: toNumber(item.change),
      volume: pickVolume(item).value,
    }));

  const output = {
    capturedAt: new Date().toISOString(),
    source: market.meta?.source || null,
    asOf: market.meta?.asOf || null,
    etfCount: etfs.length,
    sample: etfs.slice(0, 5),
    keyCounts,
    numericKeyCounts,
    volumeFieldAvailable: volumeRows.length > 0,
    topVolume: volumeRows,
    topGainers: gainers,
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);
  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
