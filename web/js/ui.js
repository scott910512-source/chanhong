// 화면 그리기. 상태 변경은 app.js 가 하고 여기서는 DOM 만 만든다.

import {
  num, signed, pct, price, plClass, esc, el, relTime, countryLabel, DIM_LABELS,
} from './util.js';
import { ACTION, STATUS, bandOf, consolidate, currentValue, dimLabel, formatValue } from './rules.js';

export const DIM_ORDER = ['country', 'sector', 'ticker', 'currency', 'account', 'tag', 'asset_class'];

// ---------------------------------------------------------------- 상단 요약
export function renderKpis(pf) {
  const cur = pf.baseCurrency;
  const cards = [
    { k: '총 평가금액', v: `${num(pf.totalValue)}`, x: cur },
    {
      k: '평가손익', v: signed(pf.unrealizedPl), cls: plClass(pf.unrealizedPl),
      x: pct(pf.returnPct, 2, true),
    },
    { k: '당일손익', v: signed(pf.dayPl), cls: plClass(pf.dayPl), x: '전일 종가 대비' },
    {
      k: '매입금액', v: num(pf.totalCost), x: pf.cash ? `예수금 ${num(pf.cash)}` : `${pf.positions.length}종목`,
    },
  ];
  el('#kpis').innerHTML = cards.map((c) => `
    <div class="kpi">
      <div class="k">${esc(c.k)}</div>
      <div class="v ${c.cls || ''}">${c.v}</div>
      <div class="x">${esc(c.x || '')}</div>
    </div>`).join('');
}

// ---------------------------------------------------------------- 보유 종목
export function renderPositions(pf) {
  const cur = pf.baseCurrency;
  if (!pf.positions.length) {
    el('#tblPositions').innerHTML = `<tbody><tr><td class="empty">
      아직 보유 종목이 없습니다.<br>오른쪽 위 <b>+ 추가</b> 로 매수 내역을 넣어보세요.
    </td></tr></tbody>`;
    return;
  }
  const head = `<thead><tr>
    <th class="l">종목</th><th>비중</th><th>수익률</th><th>주수</th><th>평단</th>
    <th>현재가</th><th>등락</th><th>평가액(${esc(cur)})</th><th>손익</th>
  </tr></thead>`;
  const rows = pf.positions.map((p) => `
    <tr data-ticker="${esc(p.ticker)}">
      <td class="l">
        <span class="name">${esc(p.asset.name)}</span>
        <span class="tick">${esc(p.ticker)} · ${esc(p.asset.country)} · ${esc(p.asset.sector)}</span>
      </td>
      <td><b>${pct(p.weight, 1)}</b></td>
      <td class="${plClass(p.returnPct)}">${pct(p.returnPct, 1, true)}</td>
      <td>${num(p.quantity, p.quantity % 1 ? 2 : 0)}</td>
      <td>${price(p.avgPriceLocal, p.asset.currency)}</td>
      <td><span class="editable" data-edit-price="${esc(p.ticker)}">${price(p.priceLocal, p.asset.currency)}</span></td>
      <td class="${plClass(p.dayChangePct)}">${pct(p.dayChangePct, 2, true)}</td>
      <td>${num(p.marketValueBase)}</td>
      <td class="${plClass(p.unrealizedPlBase)}">${signed(p.unrealizedPlBase)}</td>
    </tr>`).join('');

  const foot = `<tfoot><tr>
    <td class="l mut">합계 ${pf.positions.length}종목</td>
    <td><b>100%</b></td>
    <td class="${plClass(pf.returnPct)}"><b>${pct(pf.returnPct, 1, true)}</b></td>
    <td></td><td></td><td></td><td></td>
    <td><b>${num(pf.totalValue)}</b></td>
    <td class="${plClass(pf.unrealizedPl)}"><b>${signed(pf.unrealizedPl)}</b></td>
  </tr></tfoot>`;
  el('#tblPositions').innerHTML = `${head}<tbody>${rows}</tbody>${foot}`;
}

// ---------------------------------------------------------------- 관리 현황
export function renderDimChips(pf, db, active) {
  el('#dimChips').innerHTML = DIM_ORDER.map((d) => {
    const n = (pf.breakdowns[d] || []).length;
    const targeted = Object.keys(db.targets?.[d]?.items || {}).length;
    return `<button class="chip ${d === active ? 'active' : ''}" data-dim="${d}">
      ${esc(DIM_LABELS[d])}<span class="n">${n}${targeted ? `·목표${targeted}` : ''}</span>
    </button>`;
  }).join('');
}

export function renderBreakdown(pf, db, dim) {
  const buckets = pf.breakdowns[dim] || [];
  const group = db.targets?.[dim];
  const cur = pf.baseCurrency;

  if (!buckets.length) {
    el('#tblBreakdown').innerHTML = `<tbody><tr><td class="empty">표시할 항목이 없습니다.</td></tr></tbody>`;
    el('#dimHint').textContent = '';
    return;
  }

  const head = `<thead><tr>
    <th class="l">${esc(DIM_LABELS[dim])}</th><th class="c">판정</th>
    <th>현재</th><th>목표</th><th class="l">비중</th>
    <th>평가액(${esc(cur)})</th><th>손익</th>
  </tr></thead>`;

  const rows = buckets.map((b) => {
    const item = group?.items?.[b.key];
    let targetTxt = '-'; let currentTxt = pct(b.weight, 1); let verdict = '<span class="tag">목표없음</span>';
    let barCls = ''; let marker = ''; let band = '';

    if (item) {
      const { lo, hi, mode, target } = bandOf(item, group.tolerance);
      const current = currentValue(b, mode);
      targetTxt = formatValue(target, mode, cur);
      currentTxt = formatValue(current, mode, cur);
      if (hi !== null && current > hi) { verdict = '<span class="tag over">비중 많음</span>'; barCls = 'over'; }
      else if (lo !== null && current < lo) { verdict = '<span class="tag under">비중 적음</span>'; barCls = 'under'; }
      else verdict = '<span class="tag ok">적정</span>';

      if (mode === 'weight' && target !== null) {
        marker = `<u style="left:${Math.min(target, 100).toFixed(1)}%"></u>`;
        if (lo !== null && hi !== null) {
          marker += `<s style="left:${Math.min(lo, 100).toFixed(1)}%;width:${Math.max(0, Math.min(hi, 100) - Math.min(lo, 100)).toFixed(1)}%"></s>`;
        }
        band = `${lo.toFixed(0)}~${hi.toFixed(0)}%`;
      } else if (lo !== null && hi !== null) {
        band = `${formatValue(lo, mode, cur)} ~ ${formatValue(hi, mode, cur)}`;
      }
    }

    return `<tr>
      <td class="l"><span class="name">${esc(b.label)}</span>
        ${band ? `<span class="tick">허용 ${esc(band)}</span>` : ''}</td>
      <td class="c">${verdict}</td>
      <td><b>${esc(currentTxt)}</b></td>
      <td>${esc(targetTxt)}</td>
      <td class="l"><div class="bar"><i class="${barCls}" style="width:${Math.min(b.weight, 100).toFixed(1)}%"></i>${marker}</div></td>
      <td>${num(b.marketValue)}</td>
      <td class="${plClass(b.unrealizedPl)}">${signed(b.unrealizedPl)}</td>
    </tr>`;
  }).join('');

  el('#tblBreakdown').innerHTML = `${head}<tbody>${rows}</tbody>`;
  const targeted = Object.keys(group?.items || {}).length;
  el('#dimHint').textContent = targeted
    ? `목표 ${targeted}개 설정됨. 허용 범위를 벗어나면 아래 매매 안내에 나옵니다.`
    : `${DIM_LABELS[dim]} 목표가 아직 없습니다. 설정 탭에서 목표를 걸면 여기서 판정이 나옵니다.`;
}

// ---------------------------------------------------------------- 매매 안내
export function renderPlan(pf, signals) {
  const plan = consolidate(signals, pf);
  const box = el('#plan');
  if (!plan.length) {
    box.innerHTML = `<div class="plan-item none">
      <div><b>지금 할 매매 없음</b>
      <div class="why">설정한 목표 범위 안에 다 들어와 있습니다.</div></div></div>`;
    return;
  }
  box.innerHTML = plan.map((i) => {
    const cls = i.action === 'SELL' ? 'over' : 'under';
    return `<div class="plan-item">
      <span class="tag ${cls}">${ACTION[i.action]}</span>
      <div style="flex:1;min-width:0">
        <div><b>${esc(i.label)}</b>
          <span class="amt"> ${num(i.amountBase)} ${esc(pf.baseCurrency)}</span>
          ${i.shares ? `<span class="mut"> · 약 ${num(i.shares, 1)}주</span>` : ''}
          ${i.netted ? '<span class="mut"> · 매수·매도 상계</span>' : ''}
        </div>
        <div class="why">근거: ${esc(i.reasons.join(' | '))}</div>
      </div>
    </div>`;
  }).join('');
}

export function renderSignals(pf, signals) {
  const cur = pf.baseCurrency;
  const shown = signals.filter((s) => s.status !== 'OK');
  if (!shown.length) {
    el('#tblSignals').innerHTML = '<tbody><tr><td class="empty">전부 적정 범위입니다.</td></tr></tbody>';
    return;
  }
  const head = `<thead><tr>
    <th class="c">상태</th><th class="c">구분</th><th class="l">대상</th><th class="c">액션</th>
    <th>현재</th><th>목표</th><th>금액(${esc(cur)})</th><th>주수</th><th class="l">사유</th>
  </tr></thead>`;
  const rows = shown.map((s) => {
    let detail = s.reason;
    if (s.candidates.length && s.status === 'ACTIVE' && !['ticker', 'rule'].includes(s.dimension)) {
      detail = `${detail ? `${detail} / ` : ''}후보: ${s.candidates.join(', ')}`;
    }
    return `<tr class="${s.status === 'BYPASSED' ? 'mut' : ''}">
      <td class="c"><span class="tag ${s.status === 'BYPASSED' ? 'by' : ''}">${STATUS[s.status]}</span></td>
      <td class="c">${esc(dimLabel(s.dimension))}</td>
      <td class="l">${esc(s.label)}</td>
      <td class="c">${ACTION[s.action]}</td>
      <td>${esc(formatValue(s.current, s.mode, cur))}</td>
      <td>${s.target === null ? '-' : esc(formatValue(s.target, s.mode, cur))}</td>
      <td>${s.amountBase ? num(s.amountBase) : '-'}</td>
      <td>${s.shares ? num(s.shares, 1) : '-'}</td>
      <td class="l mut">${esc(detail || '-')}</td>
    </tr>`;
  }).join('');
  el('#tblSignals').innerHTML = `${head}<tbody>${rows}</tbody>`;
}

// ---------------------------------------------------------------- 경고 배너
export function renderAlerts(pf, db, extra = []) {
  const items = [...extra];
  if (pf.missingPrices.length) {
    items.push({
      kind: 'warn',
      html: `<b>현재가가 없는 종목:</b> ${esc(pf.missingPrices.join(', '))} — 
             보유 현황 표에서 현재가를 눌러 직접 넣거나, 시세 새로고침을 하세요.
             (이 종목들은 비중 계산에서 빠집니다)`,
    });
  }
  if (pf.missingFx.length) {
    items.push({
      kind: 'warn',
      html: `<b>환율이 없는 통화:</b> ${esc(pf.missingFx.join(', '))} — 설정 탭 &gt; 환율에서 직접 넣어주세요.`,
    });
  }
  if (pf.errors.length) {
    items.push({ kind: 'warn', html: `<b>거래내역 확인 필요:</b> ${esc(pf.errors.join(' / '))}` });
  }
  const stale = pf.positions.filter((p) => p.quote?.stale).map((p) => p.ticker);
  if (stale.length) {
    items.push({
      kind: 'warn',
      html: `<b>예시/과거 시세로 계산 중:</b> ${esc(stale.join(', '))} — 실제 값이 아닙니다.`,
    });
  }
  el('#alerts').innerHTML = items
    .map((i) => `<div class="alert ${i.kind === 'info' ? 'info' : ''}">${i.html}</div>`).join('');
}

// ---------------------------------------------------------------- 거래 목록
export function renderTransactions(db, { search = '', ticker = '' } = {}) {
  const q = search.trim().toLowerCase();
  const list = db.transactions
    .filter((t) => (!ticker || t.ticker === ticker))
    .filter((t) => !q || [t.ticker, t.account, t.note, db.assets[t.ticker]?.name]
      .some((v) => String(v || '').toLowerCase().includes(q)))
    .slice().reverse();

  const box = el('#txList');
  if (!list.length) {
    box.innerHTML = `<div class="empty">거래 내역이 없습니다.<br>
      <b>+ 추가</b> 를 눌러 매수 내역부터 넣어주세요.</div>`;
    return;
  }
  box.innerHTML = list.map((t) => {
    const asset = db.assets[t.ticker] || {};
    const cur = asset.currency || 'USD';
    const total = t.quantity * t.price + (t.side === 'BUY' ? (t.fee || 0) : -(t.fee || 0));
    return `<div class="tx" data-id="${esc(t.id)}">
      <span class="side ${t.side}">${t.side === 'BUY' ? '매수' : '매도'}</span>
      <div style="min-width:0">
        <div class="name">${esc(asset.name || t.ticker)}
          <span class="mut" style="font-weight:400">${esc(t.ticker)}</span></div>
        <div class="meta">${esc(t.date)} · ${num(t.quantity, t.quantity % 1 ? 2 : 0)}주 ×
          ${price(t.price, cur)} · ${esc(t.account || '기본')}${t.note ? ` · ${esc(t.note)}` : ''}</div>
      </div>
      <div class="amt">${price(total, cur)}<div class="meta">${esc(cur)}</div></div>
    </div>`;
  }).join('');
}

export function renderTopSub(pf, db, serverMode) {
  const q = Object.values(db.quotes || {});
  const newest = q.map((x) => x.asOf).filter(Boolean).sort().pop();
  const srcs = [...new Set(q.map((x) => x.source).filter(Boolean))];
  el('#topSub').textContent =
    `${pf.positions.length}종목 · 시세 ${relTime(newest)}${srcs.length ? ` · ${srcs.slice(0, 2).join(',')}` : ''}${serverMode ? ' · 서버연결' : ''}`;
}

export { countryLabel };
