// 목표 대비 판정 -> 매수/매도 안내. 예외(BYPASS) 처리 포함.
//
// 목표는 3가지 방식으로 걸 수 있다.
//   weight : 비중 %      (허용오차 tolerance 는 %p)
//   amount : 투자금액     (허용오차는 목표금액의 %)
//   shares : 주 수량      (허용오차는 목표주수의 %, 종목 축에서만 의미 있음)

import { DIM_LABELS, MODE_LABELS } from './util.js';

export const STATUS = { ACTIVE: '실행', BYPASSED: '예외', MUTED: '참고', OK: '적정' };
export const ACTION = { BUY: '매수', SELL: '매도', HOLD: '유지' };

export function dimLabel(dim) { return DIM_LABELS[dim] || dim; }
export function modeLabel(mode) { return MODE_LABELS[mode] || mode; }

// 그룹 기본 허용오차 (설정에 없을 때)
const DEFAULT_TOLERANCE = { weight: 5, amount: 10, shares: 10 };

export function bandOf(item, groupTolerance) {
  const mode = item.mode || 'weight';
  const tol = num(item.tolerance) ?? num(groupTolerance) ?? DEFAULT_TOLERANCE[mode];
  const target = num(item.target);
  let lo = num(item.min);
  let hi = num(item.max);
  if (target !== null) {
    if (lo === null) lo = mode === 'weight' ? Math.max(0, target - tol) : target * (1 - tol / 100);
    if (hi === null) hi = mode === 'weight' ? target + tol : target * (1 + tol / 100);
  }
  return { lo, hi, tol, mode, target };
}

// 축/모드에 따라 "지금 값"을 뽑는다
export function currentValue(bucket, mode) {
  if (!bucket) return 0;
  if (mode === 'amount') return bucket.marketValue || 0;
  if (mode === 'shares') return bucket.quantity || 0;
  return bucket.weight || 0;
}

export function formatValue(v, mode, baseCurrency = 'KRW') {
  if (v === null || v === undefined) return '-';
  if (mode === 'weight') return `${v.toFixed(1)}%`;
  if (mode === 'shares') return `${trimNum(v)}주`;
  return `${Math.round(v).toLocaleString('ko-KR')} ${baseCurrency}`;
}

function trimNum(v) {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

// ---------------------------------------------------------------- 예외(BYPASS)
export class BypassRegistry {
  constructor(db, { extra = [], disabled = false, today = null } = {}) {
    this.enabled = (db.bypass?.enabled ?? true) && !disabled;
    this.today = today || new Date().toISOString().slice(0, 10);
    this.entries = [...(db.bypass?.entries || []), ...extra];
    this.hits = new Set();
  }

  isActive(entry) {
    if (!entry.until) return true;
    return this.today <= String(entry.until);
  }

  check(dimension, key) {
    if (!this.enabled) return null;
    for (const e of this.entries) {
      if (!this.isActive(e)) continue;
      const scopeOk = e.scope === 'all' || e.scope === '*' || e.scope === dimension;
      const keyOk = !e.key || e.key === '*'
        || String(e.key).toUpperCase() === String(key).toUpperCase();
      if (scopeOk && keyOk) {
        this.hits.add(`${e.scope}:${e.key}`);
        return e;
      }
    }
    return null;
  }

  get unused() {
    return this.entries.filter((e) => !this.isActive(e) || !this.hits.has(`${e.scope}:${e.key}`));
  }
}

// ---------------------------------------------------------------- 판정
export function evaluate(pf, db, bypass = null) {
  const reg = bypass || new BypassRegistry(db);
  const signals = [];
  const total = pf.totalValue;
  if (!total) return { signals, bypass: reg };

  const minTrade = Number(db.rules?.min_trade_amount) || 0;

  for (const [dim, group] of Object.entries(db.targets || {})) {
    if (group?.enabled === false) continue;
    const buckets = new Map((pf.breakdowns[dim] || []).map((b) => [b.key, b]));
    const seen = new Set();

    for (const [key, rawItem] of Object.entries(group.items || {})) {
      seen.add(key);
      const item = { ...rawItem, mode: rawItem.mode || 'weight' };
      const bucket = buckets.get(key);
      const { lo, hi, mode, target } = bandOf(item, group.tolerance);
      const current = currentValue(bucket, mode);

      let action = 'HOLD';
      let anchor = target ?? current;
      if (hi !== null && current > hi) { action = 'SELL'; anchor = target ?? hi; }
      else if (lo !== null && current < lo) { action = 'BUY'; anchor = target ?? lo; }

      const sig = {
        dimension: dim,
        key,
        label: bucket?.label || key,
        mode,
        action,
        status: action === 'HOLD' ? 'OK' : 'ACTIVE',
        current,
        target,
        min: lo,
        max: hi,
        gap: target === null ? null : current - target,
        amountBase: 0,
        shares: null,
        reason: item.note || '',
        candidates: [],
        candidateTickers: [],
      };

      if (action !== 'HOLD') {
        const diff = Math.abs(current - anchor);
        if (mode === 'weight') sig.amountBase = (diff / 100) * total;
        else if (mode === 'amount') sig.amountBase = diff;
        else sig.amountBase = diff * priceBaseOf(pf, key);
      }
      finalize(sig, pf, db, reg, item.bypass, minTrade);
      signals.push(sig);
    }

    // 목표를 안 정한 그룹도 참고용으로 보여준다
    for (const [key, bucket] of buckets) {
      if (seen.has(key)) continue;
      signals.push({
        dimension: dim, key, label: bucket.label, mode: 'weight', action: 'HOLD',
        status: 'MUTED', current: bucket.weight, target: null, min: null, max: null,
        gap: null, amountBase: 0, shares: null, reason: '목표 미설정',
        candidates: [], candidateTickers: [],
      });
    }
  }

  signals.push(...positionRules(pf, db, reg, minTrade));

  const order = { SELL: 0, BUY: 1, HOLD: 2 };
  const rank = { ACTIVE: 0, BYPASSED: 1, MUTED: 2, OK: 3 };
  signals.sort((a, b) => (rank[a.status] - rank[b.status])
    || (order[a.action] - order[b.action])
    || (b.amountBase - a.amountBase));
  return { signals, bypass: reg };
}

function priceBaseOf(pf, ticker) {
  const p = pf.positions.find((x) => x.ticker === ticker);
  return p && p.hasPrice ? p.priceLocal * p.fx : 0;
}

// 종목 단위 안전장치 (비중 상·하한, 익절, 손절)
function positionRules(pf, db, reg, minTrade) {
  const out = [];
  const r = db.rules || {};
  const maxW = num(r.max_position_weight);
  const minW = num(r.min_position_weight);
  const tp = num(r.take_profit_pct);
  const sl = num(r.stop_loss_pct);

  for (const p of pf.positions) {
    if (!p.hasPrice) continue;
    const name = p.asset.name;
    const push = (action, amount, reason) => {
      const sig = {
        // 개별규칙의 '현재값'은 비중(%)이고, 조정 금액만 기준통화다
        dimension: 'rule', key: p.ticker, label: name, mode: 'weight', action,
        status: 'ACTIVE', current: p.weight, target: null, min: null, max: null,
        gap: null, amountBase: amount, shares: null, reason,
        candidates: [], candidateTickers: [],
      };
      finalize(sig, pf, db, reg, false, minTrade);
      out.push(sig);
    };

    if (maxW !== null && p.weight > maxW) {
      push('SELL', ((p.weight - maxW) / 100) * pf.totalValue, `1종목 비중 상한 ${maxW}% 초과`);
    }
    if (minW !== null && p.weight > 0 && p.weight < minW) {
      push('BUY', ((minW - p.weight) / 100) * pf.totalValue,
        `자투리 종목 - 비중 하한 ${minW}% 미만 (정리 또는 추가매수)`);
    }
    if (p.returnPct === null) continue;
    if (tp !== null && p.returnPct >= tp) {
      push('SELL', (p.marketValueBase || 0) * 0.25,
        `목표 수익률 도달 (${p.returnPct.toFixed(1)}% ≥ ${tp}%) - 일부 익절 검토`);
    }
    if (sl !== null && p.returnPct <= sl) {
      push('SELL', p.marketValueBase || 0,
        `손절선 이탈 (${p.returnPct.toFixed(1)}% ≤ ${sl}%) - 대응 필요`);
    }
  }
  return out;
}

function finalize(sig, pf, db, reg, itemBypass, minTrade) {
  if (sig.action === 'BUY' || sig.action === 'SELL') attachExecution(sig, pf);
  if (sig.status !== 'ACTIVE') return;

  if (itemBypass) {
    sig.status = 'BYPASSED';
    sig.reason = join(sig.reason, '설정에서 이 항목 예외 처리');
    return;
  }
  let hit = reg.check(sig.dimension, sig.key);
  if (!hit && sig.dimension === 'rule') hit = reg.check('ticker', sig.key);
  if (hit) {
    sig.status = 'BYPASSED';
    sig.reason = join(sig.reason, `예외: ${hit.reason || '사유 미기재'}${hit.until ? `, ~${hit.until}` : ''}`);
    return;
  }
  if (minTrade && sig.amountBase < minTrade) {
    sig.status = 'MUTED';
    sig.reason = join(sig.reason, `조정금액이 최소 매매금액(${minTrade.toLocaleString('ko-KR')}) 미만`);
  }
}

function attachExecution(sig, pf) {
  const direct = pf.positions.find((p) => p.ticker === sig.key);
  if (direct) {
    const priceBase = direct.hasPrice ? direct.priceLocal * direct.fx : 0;
    if (priceBase) {
      let shares = sig.amountBase / priceBase;
      if (sig.action === 'SELL') shares = Math.min(shares, direct.quantity);
      sig.shares = shares;
    }
    sig.candidates = [direct.asset.name];
    sig.candidateTickers = [sig.key];
    return;
  }
  // 국가/섹터 같은 그룹 신호는 그룹 안에서 실행 후보를 골라준다
  const members = pf.positions.filter((p) => memberOf(p, sig.dimension, sig.key) && p.hasPrice);
  if (!members.length) return;
  members.sort((a, b) => (sig.action === 'SELL'
    ? (b.returnPct ?? 0) - (a.returnPct ?? 0) || b.weight - a.weight   // 많이 오른 것부터 덜어냄
    : (a.returnPct ?? 0) - (b.returnPct ?? 0) || a.weight - b.weight)); // 덜 오른 것부터 채움
  sig.candidates = members.slice(0, 3).map((p) => p.asset.name);
  sig.candidateTickers = members.slice(0, 3).map((p) => p.ticker);
}

function memberOf(pos, dim, key) {
  switch (dim) {
    case 'country': return pos.asset.country === key;
    case 'sector': return (pos.asset.sector || '기타') === key;
    case 'currency': return pos.asset.currency === key;
    case 'asset_class': return (pos.asset.asset_class || '주식') === key;
    case 'ticker': return pos.ticker === key;
    case 'account': return pos.accounts.includes(key);
    case 'tag': return (pos.asset.tags || []).includes(key);
    default: return false;
  }
}

// ---------------------------------------------------------------- 주문서 합치기
// 국가 초과 + 섹터 초과 + 종목 상한이 사실상 같은 매도를 가리키므로 금액을 더하지 않고
// 가장 큰 제약 하나만 남긴다. 매수/매도가 동시에 걸리면 상계한다.
export function consolidate(signals, pf) {
  const byTicker = new Map();
  for (const s of signals) {
    if (s.status !== 'ACTIVE' || (s.action !== 'BUY' && s.action !== 'SELL')) continue;
    const ticker = s.candidateTickers[0] || s.key;
    if (!byTicker.has(ticker)) byTicker.set(ticker, {});
    const slot = byTicker.get(ticker);
    const tag = `${dimLabel(s.dimension)}:${s.label}${s.reason ? ` (${s.reason.split(' / ')[0]})` : ''}`;
    const cur = slot[s.action] || { amount: 0, reasons: [] };
    slot[s.action] = { amount: Math.max(cur.amount, s.amountBase), reasons: [...cur.reasons, tag] };
  }

  const plan = [];
  for (const [ticker, actions] of byTicker) {
    const sell = actions.SELL || { amount: 0, reasons: [] };
    const buy = actions.BUY || { amount: 0, reasons: [] };
    const netted = Boolean(sell.amount && buy.amount);
    const diff = sell.amount - buy.amount;
    const action = diff > 0 ? 'SELL' : 'BUY';
    const amount = Math.abs(diff);
    if (amount < 1) continue;

    const pos = pf.positions.find((p) => p.ticker === ticker);
    let shares = null;
    if (pos?.hasPrice) {
      const priceBase = pos.priceLocal * pos.fx;
      if (priceBase) {
        shares = amount / priceBase;
        if (action === 'SELL') shares = Math.min(shares, pos.quantity);
      }
    }
    plan.push({
      ticker,
      label: pos ? pos.asset.name : ticker,
      action,
      amountBase: amount,
      shares,
      netted,
      reasons: [...sell.reasons, ...buy.reasons],
    });
  }
  plan.sort((a, b) => (a.action === b.action ? b.amountBase - a.amountBase
    : a.action === 'SELL' ? -1 : 1));
  return plan;
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function join(a, b) { return a ? `${a} / ${b}` : b; }
