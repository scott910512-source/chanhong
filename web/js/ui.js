// 화면 그리기. 상태 변경은 app.js 가 하고 여기서는 DOM 만 만든다.
// 표(table) 를 걷어내고 iOS 설정앱 같은 리스트로 통일했다.

import { num, signed, pct, price, plClass, esc, el, relTime } from './util.js';
import { ACTION, bandOf, consolidate, currentValue, formatValue } from './rules.js';

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
        <div class="sub-txt">${num(p.quantity, p.quantity % 1 ? 2 : 0)}주 ·
          평단 ${price(p.avgPriceLocal, p.asset.currency)}</div>
      </span>
      <span class="right">
        <div class="v">${pct(p.weight, 1)}</div>
        <div class="s">${p.hasPrice ? num(p.marketValueBase) : '—'}
          <b class="${plClass(p.returnPct)}">${pct(p.returnPct, 1, true)}</b></div>
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

// ─────────────────────────────── 경고 (맨 위에 한 줄씩 작게)
// 국가·섹터·종목 규칙이 사실상 같은 매매를 가리키는 경우가 많아서,
// 주문서 합산(consolidate)을 거쳐 종목당 한 줄만 보여준다.
const MAX_TIPS = 4;

export function renderTopWarnings(pf, signals, { expanded = false } = {}) {
  const plan = consolidate(signals, pf);
  const bypassed = signals.filter((s) => s.status === 'BYPASSED');
  if (!plan.length && !bypassed.length) { el('#topWarn').innerHTML = ''; return; }

  const shown = expanded ? plan : plan.slice(0, MAX_TIPS);
  const rows = shown.map((i) => {
    const sell = i.action === 'SELL';
    const why = i.reasons[0] ? i.reasons[0].split(' (')[0] : '';
    const more = i.reasons.length > 1 ? ` 외 ${i.reasons.length - 1}` : '';
    return `<button class="tip ${sell ? 'sell' : 'buy'}" data-jump="${esc(i.ticker)}">
      <span class="mk">${sell ? '−' : '+'}</span>
      <span class="tx"><b>${esc(i.label)}</b> ${ACTION[i.action]}
        ${num(i.amountBase)}${i.shares ? ` · ${num(i.shares, 1)}주` : ''}</span>
      <span class="amt">${esc(why + more)}</span>
    </button>`;
  }).join('');

  const rest = plan.length - shown.length;
  const moreRow = rest > 0
    ? `<button class="tip mute" data-expand><span class="mk">+</span>
        <span class="tx">${rest}건 더 보기</span></button>`
    : '';
  const byRow = bypassed.length
    ? `<button class="tip mute" data-jump="bypass"><span class="mk">×</span>
        <span class="tx">예외 처리 ${bypassed.length}건</span>
        <span class="amt">${esc(bypassed.slice(0, 2).map((s) => s.label).join(', '))}</span></button>`
    : '';
  el('#topWarn').innerHTML = `<div class="tips">${rows}${moreRow}${byRow}</div>`;
}

// ─────────────────────────────── 관리 화면 (종목별로 접히는 매매 내역)
export function renderManage(pf, db, { search = '', open = null } = {}) {
  const q = search.trim().toLowerCase();
  const rows = pf.positions.filter((p) => !q
    || [p.asset.name, p.ticker].some((v) => String(v).toLowerCase().includes(q)));

  // 전량 매도해서 보유는 없지만 기록은 남은 종목도 보여준다
  const held = new Set(pf.positions.map((p) => p.ticker));
  const closed = [...new Set(db.transactions.map((t) => t.ticker))]
    .filter((t) => !held.has(t))
    .filter((t) => !q || String(db.assets[t]?.name || t).toLowerCase().includes(q));

  el('#txCount').textContent = `${rows.length + closed.length}종목 · 거래 ${db.transactions.length}건`;
  if (!rows.length && !closed.length) {
    el('#manageList').innerHTML = `<div class="empty">${q ? '검색 결과가 없습니다.'
      : '아직 종목이 없습니다.<br>아래 <b>+ 새 종목 추가</b> 로 시작하세요.'}</div>`;
    return;
  }

  const block = (ticker, name, sub, right) => {
    const isOpen = open === ticker;
    const txs = db.transactions.filter((t) => t.ticker === ticker)
      .slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    const cur = db.assets[ticker]?.currency || 'USD';
    return `<button class="stock-head" data-stock="${esc(ticker)}">
        <span style="flex:1;min-width:0">
          <div class="main-txt">${esc(name)}</div>
          <div class="sub-txt">${esc(sub)}</div>
        </span>
        <span class="right">${right}</span>
        <span class="chev">${isOpen ? '⌄' : '›'}</span>
      </button>
      ${isOpen ? `<div class="trades">
        ${txs.map((t) => `<button class="trade" data-id="${esc(t.id)}">
          <span class="sd ${t.side}">${t.side === 'BUY' ? '매수' : '매도'}</span>
          <span style="flex:1">${esc(t.date)} · ${num(t.quantity, t.quantity % 1 ? 2 : 0)}주
            × ${price(t.price, cur)}</span>
          <span class="mut" style="font-size:12px">수정 ›</span>
        </button>`).join('') || '<div class="trade mut">매매 내역이 없습니다</div>'}
        <div class="act-row">
          <button class="act" data-buy="${esc(ticker)}">+ 매수</button>
          <button class="act" data-sell="${esc(ticker)}">− 매도</button>
          <button class="act danger" data-drop="${esc(ticker)}">종목 삭제</button>
        </div>
      </div>` : ''}`;
  };

  el('#manageList').innerHTML = [
    ...rows.map((p) => block(
      p.ticker, p.asset.name,
      `${num(p.quantity, p.quantity % 1 ? 2 : 0)}주 · 평단 ${price(p.avgPriceLocal, p.asset.currency)}`,
      `<div class="v">${p.hasPrice ? num(p.marketValueBase) : '—'}</div>
       <div class="s ${plClass(p.returnPct)}">${pct(p.returnPct, 1, true)}</div>`,
    )),
    ...closed.map((t) => block(
      t, db.assets[t]?.name || t, '보유 없음 (기록만 남음)',
      '<div class="s mut">청산</div>',
    )),
  ].join('');
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
