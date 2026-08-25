// 브라우저에서 직접 시세를 받아온다.
//
// 중요한 제약: 브라우저는 CORS 를 허용한 서버만 부를 수 있다.
// Yahoo / 네이버 / Stooq 는 CORS 를 안 열어놔서 폰에서 직접은 못 부른다.
// 그래서 실제로 폰에서 쓸 수 있는 경로는 이렇게 된다.
//
//   1) 로컬 서버 (PC 에서 python3 -m portfolio serve) -> 있으면 이게 제일 정확
//   2) Twelve Data / Finnhub / Alpha Vantage -> 무료 키를 넣으면 브라우저에서 바로 됨
//   3) 베트남 TCBS / VNDirect -> 키 없이 되는 편 (막히면 자동으로 건너뜀)
//   4) 환율은 frankfurter / open.er-api -> 키 없이 브라우저에서 됨
//   5) 전부 안 되면 -> 현재가 직접 입력 (앱에서 숫자 탭해서 수정)

const TIMEOUT = 9000;

async function getJSON(url, { timeout = TIMEOUT } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, mode: 'cors', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- 사이트 자동수집 파일
// 깃허브 액션이 야후에서 받아 web/quotes.json 으로 올려둔 값.
// 앱과 같은 주소라서 CORS 문제도, API 키도 없다. 폰에서 제일 먼저 시도한다.
export async function fromSiteFile() {
  const res = await fetch(`./quotes.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`quotes.json 없음 (HTTP ${res.status})`);
  const d = await res.json();
  const quotes = {};
  for (const [ticker, q] of Object.entries(d.quotes || {})) {
    if (!Number.isFinite(q.price)) continue;
    quotes[ticker] = {
      price: q.price,
      previousClose: Number.isFinite(q.previousClose) ? q.previousClose : null,
      currency: q.currency,
      source: q.source || '자동수집',
      asOf: q.asOf || d.generatedAt || new Date().toISOString(),
      stale: false,
    };
  }
  return { quotes, fx: d.fx || null, generatedAt: d.generatedAt };
}

// ---------------------------------------------------------------- 로컬 서버
export async function detectServer() {
  // 로컬 서버는 집 안에서만 의미가 있다. 깃허브 페이지 같은 곳에서 매번 404 를
  // 찍지 않도록 사설망/로컬에서만 확인한다.
  const h = location.hostname;
  const local = h === 'localhost' || h === '127.0.0.1'
    || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (!local) return false;
  try {
    const res = await fetch('/api/ping', { cache: 'no-store', signal: AbortSignal.timeout(2500) });
    if (!res.ok) return false;
    const d = await res.json();
    return d?.app === 'portfolio';
  } catch { return false; }
}

async function fromServer(tickers) {
  const d = await getJSON('/api/quotes?refresh=1', { timeout: 25000 });
  const out = {};
  for (const t of tickers) {
    const q = d.quotes?.[t];
    if (q) {
      out[t] = {
        price: q.price, previousClose: q.previous_close, currency: q.currency,
        source: `서버(${q.source})`, asOf: q.as_of || new Date().toISOString(), stale: !!q.stale,
      };
    }
  }
  return { quotes: out, fx: d.fx?.rates || null };
}

// ---------------------------------------------------------------- 종목 공급자
// 각 공급자는 (ticker, asset, keys) -> quote | null

const twelvedata = {
  id: 'twelvedata',
  label: 'Twelve Data',
  needsKey: 'twelvedata',
  // 한국 005930.KS -> 005930:KRX / 베트남 FPT.VN -> FPT:HOSE
  symbol(ticker, asset) {
    if (/\.(KS|KQ)$/.test(ticker)) return `${ticker.split('.')[0]}:KRX`;
    if (/\.VN$/.test(ticker)) return `${ticker.split('.')[0]}:HOSE`;
    return ticker;
  },
  async fetch(ticker, asset, keys) {
    const sym = encodeURIComponent(this.symbol(ticker, asset));
    const d = await getJSON(`https://api.twelvedata.com/quote?symbol=${sym}&apikey=${keys.twelvedata}`);
    if (d.status === 'error' || !d.close) throw new Error(d.message || '가격 없음');
    return {
      price: Number(d.close),
      previousClose: Number(d.previous_close) || null,
      currency: d.currency || asset.currency,
    };
  },
};

const finnhub = {
  id: 'finnhub',
  label: 'Finnhub',
  needsKey: 'finnhub',
  countries: ['US'],
  async fetch(ticker, asset, keys) {
    const d = await getJSON(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${keys.finnhub}`);
    if (!d.c) throw new Error('가격 없음');
    return { price: Number(d.c), previousClose: Number(d.pc) || null, currency: asset.currency };
  },
};

const alphavantage = {
  id: 'alphavantage',
  label: 'Alpha Vantage',
  needsKey: 'alphavantage',
  async fetch(ticker, asset, keys) {
    const d = await getJSON(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${keys.alphavantage}`);
    const q = d['Global Quote'] || {};
    const price = Number(q['05. price']);
    if (!price) throw new Error(d.Note ? '호출 한도 초과' : '가격 없음');
    return {
      price, previousClose: Number(q['08. previous close']) || null, currency: asset.currency,
    };
  },
};

// 베트남은 천VND 단위로 주는 경우가 많다 (FPT 120.5 = 120,500 VND)
const toVND = (v) => (v > 0 && v < 1000 ? v * 1000 : v);

const vietnam = {
  id: 'vietnam',
  label: 'TCBS(베트남)',
  countries: ['VN'],
  async fetch(ticker, asset) {
    const code = ticker.split('.')[0];
    const d = await getJSON(`https://apipubaws.tcbs.com.vn/stock-insight/v1/stock/second-tc-price?tickers=${code}`);
    const row = d?.data?.[0];
    if (!row?.cp) throw new Error('가격 없음');
    return {
      price: toVND(Number(row.cp)),
      previousClose: row.rp ? toVND(Number(row.rp)) : null,
      currency: 'VND',
    };
  },
};

const yahoo = {
  id: 'yahoo',
  label: 'Yahoo',
  // CORS 를 안 열어놔서 보통 실패한다. 될 때만 쓰라고 남겨둔다.
  async fetch(ticker, asset) {
    const d = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=5d&interval=1d`);
    const meta = d?.chart?.result?.[0]?.meta;
    if (!meta?.regularMarketPrice) throw new Error('가격 없음');
    return {
      price: Number(meta.regularMarketPrice),
      previousClose: Number(meta.chartPreviousClose) || null,
      currency: meta.currency || asset.currency,
    };
  },
};

export const PROVIDERS = [twelvedata, finnhub, vietnam, alphavantage, yahoo];

export function providerStatus(keys = {}) {
  return PROVIDERS.map((p) => ({
    id: p.id,
    label: p.label,
    scope: p.countries ? p.countries.join('/') : '전 세계',
    ready: !p.needsKey || Boolean(keys[p.needsKey]),
    needsKey: p.needsKey || null,
  }));
}

// ---------------------------------------------------------------- 환율
const FX_SOURCES = [
  {
    id: 'frankfurter',
    async fetch(base, symbols) {
      const d = await getJSON(`https://api.frankfurter.app/latest?from=${base}&to=${symbols.join(',')}`);
      return d.rates || {};
    },
  },
  {
    id: 'open.er-api',
    async fetch(base) {
      const d = await getJSON(`https://open.er-api.com/v6/latest/${base}`);
      return d.rates || {};
    },
  },
  {
    id: 'exchangerate.host',
    async fetch(base, symbols) {
      const d = await getJSON(`https://api.exchangerate.host/latest?base=${base}&symbols=${symbols.join(',')}`);
      return d.rates || {};
    },
  },
];

export async function fetchFx(base, currencies, log = []) {
  const need = [...new Set(currencies.filter((c) => c && c !== base))];
  const rates = { [base]: 1 };
  const sources = { [base]: 'base' };
  if (!need.length) return { rates, sources };

  for (const src of FX_SOURCES) {
    const missing = need.filter((c) => !(c in rates));
    if (!missing.length) break;
    try {
      const got = await src.fetch(base, missing);
      let n = 0;
      for (const c of missing) {
        // API 는 "기준통화 1 = X 외화" 로 주므로 역수를 취한다
        if (got[c]) { rates[c] = 1 / Number(got[c]); sources[c] = src.id; n += 1; }
      }
      log.push(n ? `환율 ${n}건: ${src.id}` : `환율 ${src.id}: 해당 통화 없음`);
    } catch (e) {
      log.push(`환율 ${src.id} 실패: ${e.message}`);
    }
  }
  const still = need.filter((c) => !(c in rates));
  if (still.length) log.push(`환율 미확보: ${still.join(', ')} (설정에서 직접 입력하세요)`);
  return { rates, sources };
}

// ---------------------------------------------------------------- 전체 수집
export async function refreshQuotes(db, { onProgress = () => {} } = {}) {
  const log = [];
  const tickers = [...new Set(db.transactions.map((t) => t.ticker))];
  const assets = Object.fromEntries(tickers.map((t) => [t, db.assets[t] || {}]));
  const keys = db.apiKeys || {};
  const quotes = {};

  // 1) 깃허브 액션이 올려둔 자동수집 파일 (야후 시세, 키 불필요)
  let siteFx = null;
  try {
    const site = await fromSiteFile();
    for (const t of tickers) {
      if (site.quotes[t]) { quotes[t] = site.quotes[t]; }
    }
    siteFx = site.fx;
    const n = Object.keys(quotes).length;
    log.push(n ? `자동수집 파일에서 ${n}건 (${site.generatedAt || ''})`
      : '자동수집 파일에 내 종목이 없음 - watchlist.json 확인 필요');
  } catch (e) {
    log.push(`자동수집 파일 없음: ${e.message}`);
  }
  const remaining = tickers.filter((t) => !quotes[t]);
  if (!remaining.length && siteFx?.rates) {
    return { quotes, fx: { rates: siteFx.rates, sources: siteFx.sources || {} }, log };
  }

  // 2) 로컬 서버가 있으면 그쪽이 제일 정확하다
  if (await detectServer()) {
    try {
      onProgress('로컬 서버에서 받는 중...');
      const r = await fromServer(remaining);
      Object.assign(quotes, r.quotes);
      log.push(`로컬 서버에서 ${Object.keys(r.quotes).length}건`);
      const fx = r.fx ? { rates: r.fx, sources: {} } : await fetchFx(db.baseCurrency, tickers.map((t) => assets[t]?.currency), log);
      return { quotes, fx, log };
    } catch (e) {
      log.push(`로컬 서버 실패: ${e.message}`);
    }
  }

  // 3) 브라우저에서 직접 (CORS 되는 것만)
  let done = 0;
  for (const ticker of tickers.filter((t) => !quotes[t])) {
    const asset = { currency: 'USD', country: 'US', ...assets[ticker] };
    onProgress(`${ticker} (${++done}/${remaining.length})`);
    let got = null;
    for (const p of PROVIDERS) {
      if (p.needsKey && !keys[p.needsKey]) continue;
      if (p.countries && !p.countries.includes(asset.country)) continue;
      try {
        const q = await p.fetch(ticker, asset, keys);
        got = { ...q, source: p.label, asOf: new Date().toISOString(), stale: false };
        log.push(`${ticker}: ${p.label}`);
        break;
      } catch (e) {
        log.push(`${ticker} @${p.id} 실패: ${e.message}`);
      }
    }
    if (got) quotes[ticker] = got;
    else log.push(`${ticker}: 모든 공급자 실패 - 기존 값 유지`);
  }

  onProgress('환율 받는 중...');
  const currencies = tickers.map((t) => (assets[t]?.currency || 'USD'));
  const fx = siteFx?.rates
    ? { rates: siteFx.rates, sources: siteFx.sources || {} }
    : await fetchFx(db.baseCurrency, currencies, log);
  return { quotes, fx, log };
}
