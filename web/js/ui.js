// 화면 그리기. 상태 변경은 app.js 가 하고 여기서는 DOM 만 만든다.
// 표(table) 를 걷어내고 iOS 설정앱 같은 리스트로 통일했다.

import { num, signed, pct, price, plClass, esc, el, relTime } from './util.js';
import { ACTION, bandOf, currentValue, formatValue } from './rules.js';

const COUNTRY_FLAG = { KR: '한국', US: '미국', VN: '베트남', JP: '일본', CN: '중국', HK: '홍콩' };

// ─────────────────────────────── 맨 위 요약 (한두 줄)
export function renderSummary(pf) {
  const pl = pf.unrealizedPl;
  el('#summary').innerHTML = `
    <div class="big">${num(pf.totalValue)}<span class="cur">${esc(pf.baseCurrency)}</span></div>
    <div class="sub">
      <b class="${plClass(pl)}">${signed(pl)} (${pct(pf.returnPct, 1, true)})</b>
      · 오늘 <b class="${plClass(pf.dayPl)}">${signed(pf.dayPl)}</b>
    </div>`;
}

// 시세 상태 한 줄 (탭하면 설정으로)
export function renderStatus(pf, db) {
  const fake = pf.positions.filter((p) => p.quote?.stale).length;
  const missing = pf.missingPrices.length;
  const fakeFx = [...new Set(pf.positions.map((p) => p.asset.currency))]
    .filter((c) => c !== pf.baseCurrency && (db.fx?.sources?.[c] || '') === '예시값');
  const newest = Object.values(db.quotes || {}).map((q) => q.asOf).filter(Boolean).sort().pop();

  let cls = '';
  let text;
  if (!pf.positions.length) {
    text = '종목을 추가하면 여기에 시세 상태가 표시됩니다';
  } else if (fake || missing || fakeFx.length) {
    cls = 'warn';
    const bits = [];
    if (fake) bits.push(`${fake}종목 예시 시세`);
    if (missing) bits.push(`${missing}종목 시세 없음`);
    if (fakeFx.length) bits.push('환율 예시값');
    text = `${bits.join(' · ')} — 실제 값이 아닙니다`;
  } else {
    text = `시세 ${relTime(newest)} 기준`;
  }
  el('#statusBar').innerHTML =
    `<button class="status ${cls}" data-goto-quotes>
       <span class="dot"></span><span>${esc(text)}</span><span class="chev">›</span>
     </button>`;
}

// ─────────────────────────────── 내 종목
export function renderPositions(pf) {
  el('#posCount').textContent = pf.positions.length ? `${pf.positions.length}종목` : '';
  if (!pf.positions.length) {
    el('#listPositions').innerHTML =
      `<div class="empty">아직 종목이 없습니다.<br>오른쪽 위 <b>추가</b> 를 눌러 시작하세요.</div>`;
    return;
  }
  el('#listPositions').innerHTML = pf.positions.map((p) => `
    <button class="row tap" data-ticker="${esc(p.ticker)}">
      <span>
        <div class="main-txt">${esc(p.asset.name)}</div>
        <div class="sub-txt">${num(p.quantity, p.quantity % 1 ? 2 : 0)}주 · 비중 ${pct(p.weight, 1)}</div>
      </span>
      <span class="right">
        <div class="v">${p.hasPrice ? num(p.marketValueBase) : '—'}</div>
        <div class="s ${plClass(p.returnPct)}">${pct(p.returnPct, 1, true)}</div>
      </span>
    </button>`).join('');
}

// ─────────────────────────────── 국가별 / 섹터별 비중
export function renderBreakdown(target, pf, db, dim) {
  const buckets = pf.breakdowns[dim] || [];
  const group = db.targets?.[dim];
  if (!buckets.length) {
    el(target).innerHTML = '<div class="empty">표시할 항목이 없습니다.</div>';
    return;
  }
  el(target).innerHTML = buckets.map((b) => {
    const item = group?.items?.[b.key];
    let pill = '';
    let barCls = '';
    let marker = '';
    let sub = '';

    if (item && item.target !== null && item.target !== undefined && item.target !== '') {
      const { lo, hi, mode, target } = bandOf(item, group.tolerance);
      const cur = currentValue(b, mode);
      if (hi !== null && cur > hi) { pill = '<span class="pill over">많음</span>'; barCls = 'over'; }
      else if (lo !== null && cur < lo) { pill = '<span class="pill under">적음</span>'; barCls = 'under'; }
      else pill = '<span class="pill ok">적정</span>';
      sub = `목표 ${formatValue(target, mode, pf.baseCurrency)}`;
      if (mode === 'weight') marker = `<u style="left:${Math.min(target, 100).toFixed(1)}%"></u>`;
    } else {
      sub = '목표 미설정';
    }

    const label = dim === 'country' ? (COUNTRY_FLAG[b.key] || b.key) : b.key;
    return `<div class="row">
      <span>
        <div class="main-txt">${esc(label)}</div>
        <div class="sub-txt">${esc(sub)} · ${num(b.marketValue)}</div>
        <div class="bar"><i class="${barCls}" style="width:${Math.min(b.weight, 100).toFixed(1)}%"></i>${marker}</div>
      </span>
      <span class="right">
        <div class="v">${pct(b.weight, 1)}</div>
        <div class="s">${pill}</div>
      </span>
    </div>`;
  }).join('');
}

// ─────────────────────────────── 섹션별 경고
const DIM_OF = { ticker: ['ticker', 'rule'], country: ['country'], sector: ['sector'] };

export function renderWarnings(target, pf, signals, kind) {
  const dims = DIM_OF[kind];
  const mine = signals.filter((s) => dims.includes(s.dimension));
  const active = mine.filter((s) => s.status === 'ACTIVE');
  const bypassed = mine.filter((s) => s.status === 'BYPASSED');

  if (!active.length && !bypassed.length) { el(target).innerHTML = ''; return; }

  const rows = active.map((s) => {
    const cls = s.action === 'SELL' ? 'sell' : 'buy';
    const mark = s.action === 'SELL' ? '−' : '+';
    const who = s.candidates.length && !['ticker', 'rule'].includes(s.dimension)
      ? ` → ${s.candidates[0]}` : '';
    const howMuch = `${num(s.amountBase)} ${pf.baseCurrency}`
      + (s.shares ? ` · 약 ${num(s.shares, 1)}주` : '');
    return `<div class="warn ${cls}">
      <span class="mark">${mark}</span>
      <span>
        <div class="t">${esc(s.label)}${esc(who)} ${ACTION[s.action]} ${esc(howMuch)}</div>
        <div class="d">${esc(reasonText(s, pf))}</div>
      </span>
    </div>`;
  }).join('');

  const byLine = bypassed.length
    ? `<div class="warn"><span class="mark" style="background:var(--label3)">×</span>
        <span><div class="t">예외 처리 ${bypassed.length}건</div>
        <div class="d">${esc(bypassed.map((s) => s.label).join(', '))} — 설정 &gt; 예외 처리</div></span></div>`
    : '';

  el(target).innerHTML = `<div class="warn-group">${rows}${byLine}</div>`;
}

function reasonText(s, pf) {
  if (s.reason) return s.reason;
  const cur = formatValue(s.current, s.mode, pf.baseCurrency);
  const tgt = s.target === null ? '-' : formatValue(s.target, s.mode, pf.baseCurrency);
  return `지금 ${cur} → 목표 ${tgt}`;
}

// ─────────────────────────────── 거래 목록
export function renderTransactions(db, { search = '' } = {}) {
  const q = search.trim().toLowerCase();
  const list = db.transactions
    .filter((t) => !q || [t.ticker, t.account, t.note, db.assets[t.ticker]?.name]
      .some((v) => String(v || '').toLowerCase().includes(q)))
    .slice().reverse();

  el('#txCount').textContent = list.length ? `${list.length}건` : '';
  if (!list.length) {
    el('#txList').innerHTML = `<div class="empty">${q ? '검색 결과가 없습니다.'
      : '거래 내역이 없습니다.<br>아래 <b>거래 추가</b> 를 눌러 시작하세요.'}</div>`;
    return;
  }
  el('#txList').innerHTML = list.map((t) => {
    const asset = db.assets[t.ticker] || {};
    const cur = asset.currency || 'USD';
    const total = t.quantity * t.price + (t.side === 'BUY' ? (t.fee || 0) : -(t.fee || 0));
    return `<button class="row tap" data-id="${esc(t.id)}">
      <span>
        <div class="main-txt">${esc(asset.name || t.ticker)}
          <span class="${t.side === 'BUY' ? 'up' : 'down'}" style="font-size:13px">
            ${t.side === 'BUY' ? '매수' : '매도'}</span></div>
        <div class="sub-txt">${esc(t.date)} · ${num(t.quantity, t.quantity % 1 ? 2 : 0)}주 ×
          ${price(t.price, cur)}${t.account ? ` · ${esc(t.account)}` : ''}</div>
      </span>
      <span class="right">
        <div class="v">${price(total, cur)}</div>
        <div class="s mut">${esc(cur)}</div>
      </span>
    </button>`;
  }).join('');
}

// ─────────────────────────────── 종목 검색 결과
export function renderPickResults(results, query) {
  if (!results.length) {
    el('#pickResults').innerHTML = query
      ? `<div class="empty">사전에 없는 종목입니다.<br>
           <b>${esc(query)}</b> 를 티커로 그대로 쓰려면 아래를 누르세요.
           <div style="margin-top:12px"><button class="btn-plain strong" data-use-raw="${esc(query)}">
             "${esc(query)}" 직접 등록</button></div></div>`
      : '<div class="empty">종목 이름이나 코드를 입력하세요.</div>';
    return;
  }
  el('#pickResults').innerHTML = results.map((r) => `
    <button class="pick-row" data-pick='${esc(JSON.stringify(r))}'>
      <span class="flag">${esc(r.country)}</span>
      <span style="flex:1;min-width:0">
        <div class="main-txt">${esc(r.name)}${r.owned ? ' <span class="pill">보유</span>' : ''}</div>
        <div class="sub-txt">${esc(r.ticker)}${r.english ? ` · ${esc(r.english)}` : ''} · ${esc(r.sector)}</div>
      </span>
    </button>`).join('');
}
