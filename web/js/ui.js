// 화면 그리기. 상태 변경은 app.js 가 하고 여기서는 DOM 만 만든다.

import { num, signed, pct, price, plClass, esc, el, relTime } from './util.js';
import { ACTION, bandOf, consolidate, currentValue, formatValue } from './rules.js';

const COUNTRY_NAME = { KR: '한국', US: '미국', VN: '베트남', JP: '일본', CN: '중국', HK: '홍콩', TW: '대만' };

// 검증된 카테고리 팔레트 8색 + '기타'. 순서 고정이고 절대 돌려쓰지 않는다.
const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)',
  'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];
const OTHER = 'var(--s9)';
const MAX_SERIES = 8;

export const SORTS = { amount: '금액순', gain: '수익률순', name: '이름순' };
export const BASES = { amount: '금액 기준', shares: '수량 기준' };

export function sortPositions(positions, key) {
  const list = [...positions];
  if (key === 'gain') return list.sort((a, b) => (b.returnPct ?? -1e9) - (a.returnPct ?? -1e9));
  if (key === 'name') return list.sort((a, b) => a.asset.name.localeCompare(b.asset.name, 'ko'));
  return list.sort((a, b) => (b.marketValueBase || 0) - (a.marketValueBase || 0));
}

// ─────────────────────────────── 상단 파란 카드
export function renderHero(pf) {
  const cur = pf.baseCurrency;
  const now = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  el('#hero').innerHTML = `<div class="hero">
    <div class="hero-top">
      <span class="lb">총 자산</span>
      <button class="more" data-goto="trades">자산 상세 ›</button>
    </div>
    <div class="amount">${num(pf.totalValue)}<span style="font-size:19px;margin-left:4px">${esc(cur)}</span></div>
    <div class="hero-grid">
      <div><div class="k">평가손익</div><div class="v">${signed(pf.unrealizedPl)}</div></div>
      <div><div class="k">수익률</div><div class="v">${pct(pf.returnPct, 2, true)}</div></div>
    </div>
    <div class="hero-foot">
      <span class="l">오늘 변동 ${signed(pf.dayPl)}${dayPctText(pf)}</span>
      <span class="r">기준: 오늘 ${esc(now)}</span>
    </div>
  </div>`;
}

function dayPctText(pf) {
  const base = pf.totalValue - pf.dayPl;
  if (!base || !pf.dayPl) return '';
  return ` (${pct((pf.dayPl / base) * 100, 2, true)})`;
}

export function renderSyncChip(session, serverOk) {
  const box = el('#syncChip');
  if (session) {
    box.innerHTML = `<div class="synced"><span class="dot"></span>
      포트폴리오 동기화됨 · ${esc(session.email || '')}</div>`;
  } else if (serverOk === false) {
    box.innerHTML = `<button class="synced off" data-goto-login><span class="dot"></span>
      이 기기에만 저장 중 · 로그인하면 어디서나 ›</button>`;
  } else {
    box.innerHTML = '';
  }
}

// ─────────────────────────────── 국가별 (도넛)
export function renderCountryCard(pf, db, basis) {
  const items = allocItems(pf, db, 'country', basis);
  const head = cardHead('국가별 비중', 'country', basis);
  if (!items.length) {
    el('#cardCountry').innerHTML = `${head}<div class="empty">종목을 추가하면 보입니다.</div>`;
    return;
  }
  el('#cardCountry').innerHTML = `${head}
    <div class="donut-wrap">
      ${donut(items, pf)}
      <div class="alloc">
        <div class="alloc-h"><span>국가</span><span style="text-align:right">현재 비중 / 목표 비중</span><span></span></div>
        ${items.map(allocRow).join('')}
        ${sumRow(items)}
      </div>
    </div>`;
}

function donut(items, pf) {
  const R = 52;
  const C = 2 * Math.PI * R;
  let off = 0;
  const arcs = items.map((it, i) => {
    const len = Math.max((it.weight / 100) * C, 1.5);
    const seg = `<circle cx="66" cy="66" r="${R}" fill="none" stroke="${it.color}"
      stroke-width="21" stroke-dasharray="${Math.max(len - 2.5, 1)} ${C - len + 2.5}"
      stroke-dashoffset="${-off}" transform="rotate(-90 66 66)"/>`;
    off += len;
    return seg;
  }).join('');
  return `<div class="donut">
    <svg viewBox="0 0 132 132" width="132" height="132" role="img" aria-label="국가별 비중">${arcs}</svg>
    <div class="mid"><div class="t">총 자산</div><div class="n">${num(pf.totalValue)}원</div></div>
  </div>`;
}

// ─────────────────────────────── 섹터별 (가로 막대)
export function renderSectorCard(pf, db, basis) {
  const items = allocItems(pf, db, 'sector', basis);
  const head = cardHead('섹터별 비중', 'sector', basis);
  if (!items.length) {
    el('#cardSector').innerHTML = `${head}<div class="empty">종목을 추가하면 보입니다.</div>`;
    return;
  }
  const max = Math.max(...items.map((i) => i.weight), 1);
  el('#cardSector').innerHTML = `${head}
    <div class="alloc-h" style="grid-template-columns:70px 1fr auto 22px;display:grid;gap:10px">
      <span>섹터</span><span></span><span style="text-align:right">현재 비중 / 목표</span><span></span>
    </div>
    ${items.map((it) => `<div class="sbar-r">
      <span class="nm">${esc(it.label)}</span>
      <span class="track">
        <i class="${it.state}" style="width:${Math.min((it.weight / max) * 100, 100).toFixed(1)}%"></i>
        ${it.target === null ? '' : `<u style="left:${Math.min((it.target / max) * 100, 100).toFixed(1)}%"></u>`}
      </span>
      <span class="vs">${it.weight.toFixed(1)}% <em>/ ${it.target === null ? '—' : `${it.target}%`}</em></span>
      ${markFor(it)}
    </div>`).join('')}
    ${sumRow(items, '70px 1fr auto 22px')}`;
}

// ─────────────────────────────── 공통
function cardHead(title, dim, basis) {
  return `<div class="card-head">
    <h2>${esc(title)}</h2>
    <button class="gear" data-goto-target="${dim}">⚙ 비중 설정</button>
    <span class="spacer"></span>
    <div class="toggle">
      ${Object.entries(BASES).map(([k, v]) =>
    `<button data-basis="${k}" class="${k === basis ? 'on' : ''}">${v}</button>`).join('')}
    </div>
  </div>`;
}

function allocItems(pf, db, dim, basis) {
  const buckets = pf.breakdowns[dim] || [];
  if (!buckets.length) return [];
  const group = db.targets?.[dim];
  const totalQty = buckets.reduce((s, b) => s + (b.quantity || 0), 0);

  const rows = buckets.map((b) => {
    const weight = basis === 'shares'
      ? (totalQty ? (b.quantity / totalQty) * 100 : 0)
      : b.weight;
    const item = group?.items?.[b.key];
    const target = (item && item.target !== null && item.target !== undefined && item.target !== '')
      ? Number(item.target) : null;
    let state = '';
    if (target !== null && item) {
      const { lo, hi, mode } = bandOf(item, group.tolerance);
      // 수량 기준으로 볼 때도 판정은 설정한 기준(보통 비중%)으로 한다
      const cur = currentValue(b, mode);
      if (hi !== null && cur > hi) state = 'over';
      else if (lo !== null && cur < lo) state = 'under';
      else state = 'ok';
    }
    return {
      key: b.key,
      label: dim === 'country' ? (COUNTRY_NAME[b.key] || b.key) : b.key,
      weight, target, state, value: b.marketValue,
    };
  }).sort((a, b) => b.weight - a.weight);

  const top = rows.slice(0, MAX_SERIES);
  const rest = rows.slice(MAX_SERIES);
  if (rest.length) {
    top.push({
      key: '__other', label: `기타 ${rest.length}개`, state: '', target: null,
      weight: rest.reduce((s, x) => s + x.weight, 0),
      value: rest.reduce((s, x) => s + x.value, 0),
    });
  }
  top.forEach((it, i) => { it.color = it.key === '__other' ? OTHER : SERIES[i]; });
  return top;
}

function allocRow(it) {
  return `<div class="alloc-r">
    <span class="nm"><i class="sw" style="background:${it.color}"></i><span>${esc(it.label)}</span></span>
    <span class="vs">${it.weight.toFixed(1)}% <em>/ ${it.target === null ? '—' : `${it.target}%`}</em></span>
    ${markFor(it)}
  </div>`;
}

// 색만으로 상태를 나타내지 않도록 기호(!, ✓)를 같이 넣는다
function markFor(it) {
  if (!it.state) return '<span class="mark none" title="목표 미설정">·</span>';
  if (it.state === 'over') return '<span class="mark over" title="비중 많음">!</span>';
  if (it.state === 'under') return '<span class="mark under" title="비중 적음">!</span>';
  return '<span class="mark ok" title="적정">✓</span>';
}

function sumRow(items, cols) {
  const now = items.reduce((s, i) => s + i.weight, 0);
  const tgt = items.reduce((s, i) => s + (i.target || 0), 0);
  const style = cols ? ` style="grid-template-columns:${cols}"` : '';
  return `<div class="alloc-sum"${style}>
    <span>합계</span>${cols ? '<span></span>' : ''}
    <span style="text-align:right">${now.toFixed(0)}% / ${tgt ? `${tgt.toFixed(0)}%` : '—'}</span>
    <span></span></div>`;
}

// ─────────────────────────────── 보유 종목 표
export function renderHoldingsCard(pf, sort) {
  if (!pf.positions.length) {
    el('#cardHoldings').innerHTML = `<div class="card-head"><h2>보유 종목</h2></div>
      <div class="empty">아직 종목이 없습니다.<br>오른쪽 위 <b>내 주식 관리</b> 에서 추가하세요.</div>`;
    return;
  }
  const rows = sortPositions(pf.positions, sort).map((p) => `
    <button class="hold-r" data-ticker="${esc(p.ticker)}">
      <span class="who">
        <span class="fl">${esc(p.asset.country)}</span>
        <span class="nmw">
          <span class="n1">${esc(p.asset.name)}</span>
          <span class="n2">${esc(p.ticker)}</span>
        </span>
      </span>
      <span class="num">${num(p.quantity, p.quantity % 1 ? 2 : 0)}주</span>
      <span class="num">${price(p.avgPriceLocal, p.asset.currency)}</span>
      <span class="num">${p.hasPrice ? num(p.marketValueBase) : '—'}</span>
      <span class="pl ${plClass(p.unrealizedPlBase)}">${signed(p.unrealizedPlBase)}
        <small>${pct(p.returnPct, 2, true)}</small></span>
      <span class="chev">›</span>
    </button>`).join('');

  el('#cardHoldings').innerHTML = `
    <div class="card-head">
      <h2>보유 종목</h2>
      <span class="spacer"></span>
      <div class="toggle" id="sortSeg">
        ${Object.entries(SORTS).map(([k, v]) =>
    `<button data-sort="${k}" class="${k === sort ? 'on' : ''}">${v}</button>`).join('')}
      </div>
    </div>
    <div class="scroll-x"><div>
      <div class="hold-h">
        <span>종목명</span><span style="text-align:right">보유 수량</span>
        <span style="text-align:right">평균 단가</span><span style="text-align:right">현재 가치</span>
        <span style="text-align:right">평가손익(수익률)</span><span></span>
      </div>
      ${rows}
    </div></div>`;
}

// ─────────────────────────────── 시세 상태 한 줄
export function renderStatus(pf, db) {
  const fake = pf.positions.filter((p) => p.quote?.stale).length;
  const missing = pf.missingPrices.length;
  const fakeFx = [...new Set(pf.positions.map((p) => p.asset.currency))]
    .filter((c) => c !== pf.baseCurrency && (db.fx?.sources?.[c] || '') === '예시값');
  const newest = Object.values(db.quotes || {}).map((q) => q.asOf).filter(Boolean).sort().pop();

  if (!pf.positions.length) { el('#statusBar').innerHTML = ''; return; }
  let cls = '';
  let text;
  if (fake || missing || fakeFx.length) {
    cls = 'off';
    const bits = [];
    if (fake) bits.push(`${fake}종목 예시 시세`);
    if (missing) bits.push(`${missing}종목 시세 없음`);
    if (fakeFx.length) bits.push('환율 예시값');
    text = `${bits.join(' · ')} — 실제 값이 아닙니다`;
  } else {
    text = `시세 ${relTime(newest)} 기준`;
  }
  el('#statusBar').innerHTML = `<div style="padding:12px 16px 0">
    <button class="synced ${cls}" style="margin:0" data-goto-quotes>
      <span class="dot"></span><span>${esc(text)}</span><span>›</span></button></div>`;
}

// ─────────────────────────────── 매매 안내
const MAX_TIPS = 4;

export function renderTopWarnings(pf, signals, { expanded = false } = {}) {
  const plan = consolidate(signals, pf);
  const bypassed = signals.filter((s) => s.status === 'BYPASSED');
  const badge = el('#alertCount');
  badge.hidden = !plan.length;
  badge.textContent = String(plan.length);

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
      <span class="amt">${esc(why + more)}</span></button>`;
  }).join('');
  const rest = plan.length - shown.length;
  const moreRow = rest > 0
    ? `<button class="tip mute" data-expand><span class="mk">+</span>
        <span class="tx">${rest}건 더 보기</span></button>` : '';
  const byRow = bypassed.length
    ? `<button class="tip mute" data-jump="bypass"><span class="mk">×</span>
        <span class="tx">예외 처리 ${bypassed.length}건</span>
        <span class="amt">${esc(bypassed.slice(0, 2).map((s) => s.label).join(', '))}</span></button>` : '';
  el('#topWarn').innerHTML = `<div class="tips">${rows}${moreRow}${byRow}</div>`;
}

// ─────────────────────────────── 관리 화면
export function renderManage(pf, db, { search = '', open = null } = {}) {
  const q = search.trim().toLowerCase();
  const rows = pf.positions.filter((p) => !q
    || [p.asset.name, p.ticker].some((v) => String(v).toLowerCase().includes(q)));
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
        <button class="trade" data-price="${esc(ticker)}">
          <span class="sd" style="color:var(--brand)">현재가</span>
          <span style="flex:1">${quoteLine(db, ticker, cur)}</span>
          <span class="mut" style="font-size:12px">저장 ›</span>
        </button>
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
    ...closed.map((t) => block(t, db.assets[t]?.name || t, '보유 없음 (기록만 남음)',
      '<div class="s mut">청산</div>')),
  ].join('');
}

function quoteLine(db, ticker, cur) {
  const q = db.quotes[ticker];
  if (!q || !Number.isFinite(q.price)) return '아직 없음 — 눌러서 입력';
  const src = q.stale ? '예시값' : (q.source || '');
  return `${price(q.price, cur)} ${cur}${src ? ` · ${src}` : ''}`;
}

// ─────────────────────────────── 종목 검색 결과
export function renderPickResults(results, query) {
  if (!results.length) {
    el('#pickResults').innerHTML = query
      ? `<div class="empty">사전에 없는 종목입니다.<br>
           <b>${esc(query)}</b> 를 티커로 그대로 쓰려면 아래를 누르세요.
           <div style="margin-top:12px"><button class="btn-plain" data-use-raw="${esc(query)}">
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
