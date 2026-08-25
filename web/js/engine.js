// 계산 엔진 - 거래내역 -> 포지션(평단/평가/손익/비중) -> 축별 집계
// 평단은 이동평균법. 매수 수수료는 평단에 포함, 매도해도 평단은 변하지 않는다.

import { COUNTRY_NAMES } from './util.js';
import { guessAsset } from './store.js';

export const DIMENSIONS = ['country', 'sector', 'ticker', 'currency', 'account', 'asset_class', 'tag'];

const KEYFN = {
  country: (p) => [p.asset.country],
  sector: (p) => [p.asset.sector || '기타'],
  ticker: (p) => [p.ticker],
  currency: (p) => [p.asset.currency],
  asset_class: (p) => [p.asset.asset_class || '주식'],
  account: (p) => (p.accounts.length ? p.accounts : ['기본']),
  tag: (p) => (p.asset.tags?.length ? p.asset.tags : ['-']),
};

export function assetOf(db, ticker) {
  const meta = db.assets[ticker] || guessAsset(ticker);
  return {
    ticker,
    name: meta.name || ticker,
    country: (meta.country || '??').toUpperCase(),
    currency: (meta.currency || 'USD').toUpperCase(),
    sector: meta.sector || '기타',
    asset_class: meta.asset_class || '주식',
    tags: meta.tags || [],
    exchange: meta.exchange || '',
  };
}

export function fxRate(db, currency) {
  if (currency === db.baseCurrency) return 1;
  const r = db.fx?.rates?.[currency];
  return Number.isFinite(r) ? r : null;
}

// 거래내역 -> 포지션 (수량 0 인 종목도 실현손익 때문에 남겨두고 나중에 거른다)
export function buildPositions(db) {
  const map = new Map();
  const sorted = [...db.transactions].sort((a, b) => (a.date < b.date ? -1 : 1));
  const errors = [];

  for (const t of sorted) {
    const ticker = t.ticker;
    let p = map.get(ticker);
    if (!p) {
      p = {
        ticker,
        asset: assetOf(db, ticker),
        quantity: 0,
        costBasisLocal: 0,
        realizedPlLocal: 0,
        accounts: [],
        firstBuy: null,
        lastTrade: null,
      };
      map.set(ticker, p);
    }
    if (t.account && !p.accounts.includes(t.account)) p.accounts.push(t.account);
    p.lastTrade = !p.lastTrade || t.date > p.lastTrade ? t.date : p.lastTrade;

    const qty = Math.abs(Number(t.quantity) || 0);
    const price = Number(t.price) || 0;
    const fee = Number(t.fee) || 0;

    if (t.side === 'BUY') {
      p.firstBuy = !p.firstBuy || t.date < p.firstBuy ? t.date : p.firstBuy;
      p.quantity += qty;
      p.costBasisLocal += qty * price + fee;
    } else {
      if (qty > p.quantity + 1e-9) {
        errors.push(`${ticker} ${t.date}: 보유 ${p.quantity}주보다 많은 ${qty}주 매도`);
      }
      const sellQty = Math.min(qty, p.quantity);
      const avg = p.quantity ? p.costBasisLocal / p.quantity : 0;
      const costOut = avg * sellQty;
      p.quantity -= sellQty;
      p.costBasisLocal -= costOut;
      p.realizedPlLocal += sellQty * price - costOut - fee;
      if (p.quantity <= 1e-9) { p.quantity = 0; p.costBasisLocal = 0; }
    }
  }
  return { positions: [...map.values()], errors };
}

export function buildPortfolio(db) {
  const { positions: all, errors } = buildPositions(db);
  const cash = Number(db.rules?.cash) || 0;

  for (const p of all) {
    p.fx = fxRate(db, p.asset.currency);
    p.realizedPlBase = p.realizedPlLocal * (p.fx ?? 0);
  }
  const held = all.filter((p) => p.quantity > 1e-9);

  for (const p of held) {
    const q = db.quotes[p.ticker] || null;
    p.quote = q;
    p.avgPriceLocal = p.quantity ? p.costBasisLocal / p.quantity : 0;
    p.priceLocal = q && Number.isFinite(q.price) ? q.price : null;
    p.hasPrice = p.priceLocal !== null && p.fx !== null;
    p.marketValueLocal = p.hasPrice ? p.priceLocal * p.quantity : null;
    p.marketValueBase = p.hasPrice ? p.marketValueLocal * p.fx : null;
    p.costBasisBase = p.costBasisLocal * (p.fx ?? 0);
    p.unrealizedPlLocal = p.hasPrice ? p.marketValueLocal - p.costBasisLocal : null;
    p.unrealizedPlBase = p.hasPrice ? p.unrealizedPlLocal * p.fx : null;
    p.returnPct = (p.hasPrice && p.costBasisLocal)
      ? (p.unrealizedPlLocal / p.costBasisLocal) * 100 : null;
    p.dayChangePct = (q && Number.isFinite(q.previousClose) && q.previousClose)
      ? ((q.price - q.previousClose) / q.previousClose) * 100 : null;
    p.dayPlBase = (p.hasPrice && Number.isFinite(q?.previousClose))
      ? (q.price - q.previousClose) * p.quantity * p.fx : null;
    // 시세를 아직 못 받은 종목은 산 값으로 친다. 0 원으로 두면 방금 넣은 종목이
    // 총 자산에서 통째로 사라지고 비중·경고도 전부 안 나온다.
    // 평가손익과 수익률은 알 수 없으니 그대로 비워두고, 아래 상태줄이 따로 알린다.
    p.valuedAtCost = !p.hasPrice;
    p.valueBase = p.hasPrice ? p.marketValueBase : p.costBasisBase;
  }

  const pricedValue = held.reduce((s, p) => s + (p.marketValueBase || 0), 0);
  const totalValue = held.reduce((s, p) => s + (p.valueBase || 0), 0) + cash;
  for (const p of held) {
    p.weight = totalValue && p.valueBase ? (p.valueBase / totalValue) * 100 : 0;
  }
  held.sort((a, b) => (b.valueBase || 0) - (a.valueBase || 0));

  const totalCost = held.reduce((s, p) => s + (p.hasPrice ? p.costBasisBase : 0), 0);
  const unrealizedPl = held.reduce((s, p) => s + (p.unrealizedPlBase || 0), 0);
  const dayPl = held.reduce((s, p) => s + (p.dayPlBase || 0), 0);
  const realizedPl = all.reduce((s, p) => s + (p.realizedPlBase || 0), 0);
  const hhi = held.reduce((s, p) => s + p.weight ** 2, 0);

  const pf = {
    baseCurrency: db.baseCurrency,
    positions: held,
    closed: all.filter((p) => p.quantity <= 1e-9 && p.realizedPlLocal !== 0),
    cash,
    pricedValue,
    totalValue,
    totalCost,
    unrealizedPl,
    returnPct: totalCost ? (unrealizedPl / totalCost) * 100 : null,
    dayPl,
    realizedPl,
    hhi,
    effectiveHoldings: hhi ? 10000 / hhi : 0,
    top3: [...held].map((p) => p.weight).sort((a, b) => b - a).slice(0, 3)
      .reduce((s, w) => s + w, 0),
    missingPrices: held.filter((p) => !p.hasPrice).map((p) => p.ticker),
    missingFx: [...new Set(held.filter((p) => p.fx === null).map((p) => p.asset.currency))],
    errors,
  };
  pf.breakdowns = buildBreakdowns(pf, db);
  return pf;
}

export function buildBreakdowns(pf, db) {
  const out = {};
  for (const dim of DIMENSIONS) {
    const buckets = new Map();
    for (const p of pf.positions) {
      if (!p.valueBase) continue;
      const keys = KEYFN[dim](p);
      const share = 1 / keys.length; // 태그/계좌가 여러 개면 균등 분할
      for (const key of keys) {
        let b = buckets.get(key);
        if (!b) {
          b = {
            key,
            label: labelFor(dim, key, p),
            marketValue: 0,
            costBasis: 0,
            dayPl: 0,
            quantity: 0,
            weight: 0,
            tickers: [],
          };
          buckets.set(key, b);
        }
        b.marketValue += p.valueBase * share;
        b.costBasis += p.costBasisBase * share;
        b.dayPl += (p.dayPlBase || 0) * share;
        b.quantity += p.quantity * share;
        b.tickers.push(p.ticker);
      }
    }
    const list = [...buckets.values()];
    for (const b of list) {
      b.weight = pf.totalValue ? (b.marketValue / pf.totalValue) * 100 : 0;
      b.unrealizedPl = b.marketValue - b.costBasis;
      b.returnPct = b.costBasis ? (b.unrealizedPl / b.costBasis) * 100 : null;
    }
    list.sort((a, b) => b.marketValue - a.marketValue);
    out[dim] = list;
  }
  if (pf.cash > 0) {
    out.asset_class.push({
      key: '현금', label: '현금', marketValue: pf.cash, costBasis: pf.cash,
      dayPl: 0, quantity: 0, unrealizedPl: 0, returnPct: null, tickers: [],
      weight: pf.totalValue ? (pf.cash / pf.totalValue) * 100 : 0,
    });
    out.asset_class.sort((a, b) => b.marketValue - a.marketValue);
  }
  return out;
}

function labelFor(dim, key, pos) {
  if (dim === 'country') return `${COUNTRY_NAMES[key] || key}(${key})`;
  if (dim === 'ticker') return `${pos.asset.name}`;
  return key;
}
