// 앱 진입점 - 상태를 들고 화면을 갱신하고 이벤트를 처리한다.

import { Store, guessAsset, naturalKey } from './store.js';
import { buildPortfolio } from './engine.js';
import { BypassRegistry, evaluate } from './rules.js';
import { providerStatus, refreshQuotes, fromSiteFile } from './quotes.js';
import { search as searchTickers, lookup } from './tickers.js';
import * as sync from './sync.js';
import * as cloud from './cloud.js';
import * as ui from './ui.js';
import { el, els, esc, num, parseNum, toast, today, price as fmtPrice } from './util.js';

const store = new Store();
const state = {
  db: null, pf: null, signals: [], bypassReg: null,
  screen: 'home', editingTxId: null, picked: null,
  installPrompt: null, fetchLog: [],
};

// ─────────────────────────────── 렌더
function recompute() {
  state.pf = buildPortfolio(state.db);
  const reg = new BypassRegistry(state.db);
  const r = evaluate(state.pf, state.db, reg);
  state.signals = r.signals;
  state.bypassReg = r.bypass;
}

function render() {
  recompute();
  const { pf, db } = state;
  ui.renderSummary(pf);
  ui.renderTopWarnings(pf, state.signals, { expanded: state.tipsExpanded });
  ui.renderStatus(pf, db);
  ui.renderPositions(pf);
  ui.renderBreakdown('#listCountry', pf, db, 'country');
  ui.renderBreakdown('#listSector', pf, db, 'sector');
  ui.renderManage(pf, db, { search: el('#txSearch').value, open: state.openStock });
  renderAccountList();
  if (state.screen === 'settings') renderSettings();
}

async function save() {
  const err = await store.save();
  if (err) toast('저장 실패 - 저장공간이 부족할 수 있습니다', 'err');
  render();
  syncPushSoon();
}

function showScreen(name) {
  state.screen = name;
  els('.seg-item').forEach((t) => t.classList.toggle('on', t.dataset.screen === name));
  els('.screen').forEach((s) => s.classList.toggle('on', s.id === `screen-${name}`));
  window.scrollTo({ top: 0 });
  if (name === 'settings') renderSettings();
}

// ─────────────────────────────── 거래 입력 (1단계: 종목 고르기)
function openSheet(txId = null) {
  state.editingTxId = txId;
  const tx = txId ? state.db.transactions.find((t) => t.id === txId) : null;
  el('#sheetTitle').textContent = tx ? '거래 수정' : '거래 추가';
  el('#btnDeleteTx').hidden = !tx;
  el('#sheet').hidden = false;

  if (tx) {
    const a = state.db.assets[tx.ticker] || guessAsset(tx.ticker);
    choose({ ticker: tx.ticker, name: a.name || tx.ticker, sector: a.sector,
      country: a.country, currency: a.currency }, tx);
  } else {
    state.picked = null;
    el('#pickStep').hidden = false;
    el('#txForm').hidden = true;
    el('#pickSearch').value = '';
    ui.renderPickResults(searchTickers('', state.db.assets), '');
    setTimeout(() => el('#pickSearch').focus(), 120);
  }
}

// 관리 화면에서 '이 종목 매수/매도' 로 바로 들어오는 경로
function openSheetFor(ticker, side) {
  const a = state.db.assets[ticker] || guessAsset(ticker);
  state.editingTxId = null;
  el('#sheetTitle').textContent = side === 'BUY' ? '매수 추가' : '매도 추가';
  el('#btnDeleteTx').hidden = true;
  el('#sheet').hidden = false;
  choose({ ticker, name: a.name || ticker, sector: a.sector, country: a.country,
    currency: a.currency });
  el('#txForm').side.value = side;
  updatePreview();
}

function dropStock(ticker) {
  const n = state.db.transactions.filter((t) => t.ticker === ticker).length;
  const name = state.db.assets[ticker]?.name || ticker;
  if (!confirm(`${name} 을(를) 매매 내역 ${n}건과 함께 지웁니다. 계속할까요?`)) return;
  state.db.transactions
    .filter((t) => t.ticker === ticker)
    .forEach((t) => store.deleteTransaction(t.id));
  store.deleteAsset(ticker);
  state.openStock = null;
  save();
  toast(`${name} 삭제했습니다`);
}

function closeSheet() {
  el('#sheet').hidden = true;
  state.editingTxId = null;
  state.picked = null;
}

function doSearch() {
  const q = el('#pickSearch').value;
  ui.renderPickResults(searchTickers(q, state.db.assets), q.trim());
}

// 종목을 고르면 2단계(내용 입력)로
function choose(item, tx = null) {
  state.picked = item;
  el('#pickStep').hidden = true;
  el('#txForm').hidden = false;
  el('#pickedChip').innerHTML =
    `<span>${esc(item.name)}</span>
     <span class="code">${esc(item.ticker)} · ${esc(item.country)}/${esc(item.currency)}</span>
     <span class="chev">›</span>`;

  const f = el('#txForm');
  f.date.value = tx?.date || today();
  f.side.value = tx?.side || 'BUY';
  f.quantity.value = tx ? tx.quantity : '';
  f.price.value = tx ? tx.price : '';
  f.fee.value = tx?.fee || '';
  f.account.value = tx?.account || lastAccount();
  f.note.value = tx?.note || '';
  el('#priceLabel').textContent = `단가 (${item.currency})`;
  updatePreview();
  if (!tx) setTimeout(() => f.quantity.focus(), 80);
}

function lastAccount() {
  return state.db.transactions[state.db.transactions.length - 1]?.account || '';
}

function updatePreview() {
  const f = el('#txForm');
  const cur = state.picked?.currency || '';
  const qty = parseNum(f.quantity.value);
  const p = parseNum(f.price.value);
  const fee = parseNum(f.fee.value);
  if (!qty || !p) { el('#txPreview').textContent = ''; return; }
  const total = qty * p + (f.side.value === 'BUY' ? fee : -fee);
  el('#txPreview').innerHTML =
    `${f.side.value === 'BUY' ? '매수' : '매도'}금액 <b>${fmtPrice(total, cur)} ${esc(cur)}</b>`;
}

function submitTx() {
  if (!state.picked) return toast('종목을 먼저 고르세요', 'err');
  const f = el('#txForm');
  const qty = Math.abs(parseNum(f.quantity.value));
  const p = parseNum(f.price.value);
  if (!qty) return toast('수량을 입력하세요', 'err');
  if (!p) return toast('단가를 입력하세요', 'err');

  const ticker = state.picked.ticker;
  const row = {
    date: f.date.value || today(), ticker, side: f.side.value, quantity: qty, price: p,
    fee: parseNum(f.fee.value), account: f.account.value.trim() || '기본',
    note: f.note.value.trim(),
  };

  if (!state.db.assets[ticker]) {
    state.db.assets[ticker] = {
      name: state.picked.name || ticker,
      country: state.picked.country || '??',
      currency: state.picked.currency || 'USD',
      sector: state.picked.sector || '기타',
      asset_class: '주식',
      tags: [],
    };
  }
  if (state.editingTxId) {
    store.updateTransaction(state.editingTxId, row);
  } else {
    const dup = state.db.transactions.find((t) => naturalKey(t) === naturalKey(row));
    if (dup && !confirm('같은 내용의 거래가 이미 있습니다. 그래도 추가할까요?')) return;
    store.addTransaction(row);
  }
  const wasEdit = Boolean(state.editingTxId);
  closeSheet();
  save();
  toast(wasEdit ? '수정했습니다' : '추가했습니다');
}

function deleteTx() {
  if (!state.editingTxId || !confirm('이 거래를 삭제할까요?')) return;
  store.deleteTransaction(state.editingTxId);
  closeSheet();
  save();
  toast('삭제했습니다');
}

// ─────────────────────────────── 현재가 직접 입력
function editPrice(ticker) {
  const a = state.db.assets[ticker] || guessAsset(ticker);
  const q = state.db.quotes[ticker];
  const input = prompt(`${a.name || ticker} 현재가 (${a.currency})`,
    q?.price != null ? String(q.price) : '');
  if (input === null) return;
  const v = parseNum(input);
  if (!v) return toast('숫자를 넣어주세요', 'err');
  store.setQuote(ticker, {
    price: v, previousClose: q?.previousClose ?? null, currency: a.currency,
    source: '직접입력', asOf: new Date().toISOString(), stale: false,
  });
  save();
  toast('반영했습니다');
}

// ─────────────────────────────── 시세
async function doRefresh(btn) {
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; }
  try {
    const r = await refreshQuotes(state.db, { onProgress: (m) => { if (btn) btn.textContent = m; } });
    let n = 0;
    for (const [t, q] of Object.entries(r.quotes)) { store.setQuote(t, q); n += 1; }
    if (r.fx?.rates) {
      state.db.fx = {
        base: state.db.baseCurrency,
        rates: { ...state.db.fx.rates, ...r.fx.rates },
        sources: { ...state.db.fx.sources, ...(r.fx.sources || {}) },
        asOf: new Date().toISOString(),
      };
    }
    state.fetchLog = r.log;
    await save();
    toast(n ? `${n}종목 갱신` : '받아온 시세가 없습니다 — 설정 > 시세 확인', n ? 'ok' : 'err');
  } catch (e) {
    state.fetchLog = [`오류: ${e.message}`];
    toast(`시세 갱신 실패: ${e.message}`, 'err');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}

// 앱 켤 때 자동수집 파일이 있으면 조용히 반영
async function loadSiteQuotes() {
  try {
    const site = await fromSiteFile();
    let n = 0;
    for (const [t, q] of Object.entries(site.quotes)) {
      if (state.db.assets[t] || state.db.transactions.some((x) => x.ticker === t)) {
        store.setQuote(t, q); n += 1;
      }
    }
    if (site.fx?.rates) {
      state.db.fx.rates = { ...state.db.fx.rates, ...site.fx.rates };
      state.db.fx.sources = { ...state.db.fx.sources, ...(site.fx.sources || {}) };
    }
    if (n) { await store.save({ snapshot: false }); render(); }
    state.fetchLog = [`자동수집 파일: ${n}종목 반영 (${site.generatedAt || '시각 불명'})`];
  } catch (e) {
    state.fetchLog = [`자동수집 파일 없음: ${e.message}`];
  }
}

// ─────────────────────────────── 설정
function renderSettings() {
  renderTargetList('#setCountry', 'country');
  renderTargetList('#setSector', 'sector');
  renderTickerTargets();
  renderQuoteSettings();
}

// 국가/섹터: % 하나만 넣는 심플한 행
function renderTargetList(target, dim) {
  const group = state.db.targets[dim] || { enabled: true, tolerance: 5, items: {} };
  state.db.targets[dim] = group;
  // 비중이 큰 것부터 (보유하지 않은 목표는 뒤로)
  const buckets = state.pf?.breakdowns?.[dim] || [];
  const keys = [...new Set([...buckets.map((b) => b.key), ...Object.keys(group.items || {})])];
  if (!keys.length) {
    el(target).innerHTML = '<div class="empty">보유 종목이 생기면 여기에 나타납니다.</div>';
    return;
  }
  const label = (k) => (dim === 'country'
    ? ({ KR: '한국', US: '미국', VN: '베트남', JP: '일본', CN: '중국' }[k] || k) : k);
  el(target).innerHTML = keys.map((k) => {
    const cur = buckets.find((b) => b.key === k);
    const t = group.items[k]?.target;
    return `<label class="row">
      <span>
        <div class="main-txt">${esc(label(k))}</div>
        <div class="sub-txt">지금 ${cur ? cur.weight.toFixed(1) : '0.0'}%</div>
      </span>
      <input data-target-dim="${dim}" data-target-key="${esc(k)}" inputmode="decimal"
             placeholder="—" value="${t ?? ''}" style="max-width:70px">
      <span class="unit">%</span>
    </label>`;
  }).join('');
}

function renderTickerTargets() {
  const group = state.db.targets.ticker || { enabled: true, tolerance: 4, items: {} };
  state.db.targets.ticker = group;
  // 평가액이 큰 종목부터 (positions 가 이미 그 순서다)
  const tickers = [...new Set([
    ...(state.pf?.positions || []).map((p) => p.ticker),
    ...Object.keys(group.items || {}),
  ])];
  if (!tickers.length) {
    el('#setTicker').innerHTML = '<div class="empty">보유 종목이 생기면 여기에 나타납니다.</div>';
    return;
  }
  const MODES = { weight: '비중 %', amount: '투자금액', shares: '주 수량' };
  el('#setTicker').innerHTML = tickers.map((t) => {
    const a = state.db.assets[t] || {};
    const item = group.items[t] || {};
    const mode = item.mode || 'weight';
    const unit = mode === 'weight' ? '%' : mode === 'shares' ? '주' : state.db.baseCurrency;
    return `<label class="row">
      <span>
        <div class="main-txt">${esc(a.name || t)}</div>
        <div class="sub-txt">
          <select data-mode-ticker="${esc(t)}" style="text-align:left;font-size:13px;color:var(--tint)">
            ${Object.entries(MODES).map(([m, l]) =>
    `<option value="${m}" ${m === mode ? 'selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
      </span>
      <input data-target-dim="ticker" data-target-key="${esc(t)}" inputmode="decimal"
             placeholder="—" value="${item.target ?? ''}" style="max-width:96px">
      <span class="unit">${esc(unit)}</span>
    </label>`;
  }).join('');
}

function collectTargets() {
  els('input[data-target-dim]').forEach((i) => {
    const dim = i.dataset.targetDim;
    const key = i.dataset.targetKey;
    const g = state.db.targets[dim];
    if (!g) return;
    const raw = i.value.trim();
    if (raw === '') { delete g.items[key]; return; }
    // 심플 화면에서 넣은 %가 그대로 먹히도록 예전 min/max/tolerance 는 지운다
    g.items[key] = {
      mode: g.items[key]?.mode || 'weight',
      target: parseNum(raw),
      note: g.items[key]?.note || '',
    };
  });
  els('select[data-mode-ticker]').forEach((s) => {
    const t = s.dataset.modeTicker;
    const g = state.db.targets.ticker;
    if (g.items[t]) g.items[t].mode = s.value;
  });
}

// 시세 설정 = API 키 + 연동 상태/에러가 전부 여기 모인다
function renderQuoteSettings() {
  const KEYS = [
    ['twelvedata', 'Twelve Data', '무료 800회/일 · 한국·미국·베트남'],
    ['finnhub', 'Finnhub', '무료 60회/분 · 미국'],
    ['alphavantage', 'Alpha Vantage', '무료 25회/일'],
  ];
  const fake = state.pf.positions.filter((p) => p.quote?.stale).map((p) => p.ticker);
  const missing = state.pf.missingPrices;
  const status = providerStatus(state.db.apiKeys || {});

  el('#setQuotes').innerHTML = `
    <button class="row tap" id="btnRefresh2">
      <span><div class="main-txt" style="color:var(--tint)">지금 시세 받기</div>
      <div class="sub-txt">야후 자동수집 → 로컬 서버 → API 키 순으로 시도합니다</div></span>
      <span class="chev">›</span>
    </button>
    ${fake.length ? warnRow('예시 시세로 계산 중', `${fake.join(', ')} — 실제 값이 아닙니다.
      종목을 눌러 현재가를 직접 고치거나 위에서 시세를 받으세요.`) : ''}
    ${missing.length ? warnRow('시세 없음', `${missing.join(', ')} — 비중 계산에서 빠집니다.`) : ''}
    ${KEYS.map(([k, name, hint]) => `
      <label class="row">
        <span><div class="main-txt">${esc(name)}</div><div class="sub-txt">${esc(hint)}</div></span>
        <input data-key="${k}" value="${esc(state.db.apiKeys?.[k] || '')}"
               placeholder="키 입력" autocomplete="off" style="max-width:130px">
      </label>`).join('')}
    <div class="row"><span>
      <div class="main-txt" style="font-size:15px">연동 상태</div>
      <div class="sub-txt">${status.map((p) => `${p.label} ${p.ready ? '✓' : '키필요'}`).join(' · ')}</div>
      <div class="sub-txt" style="margin-top:6px">${esc((state.fetchLog || []).slice(0, 6).join(' / ') || '아직 시세를 받은 적이 없습니다.')}</div>
    </span></div>`;
}

function warnRow(title, desc) {
  return `<div class="row"><span>
    <div class="main-txt" style="color:var(--orange)">${esc(title)}</div>
    <div class="sub-txt">${esc(desc)}</div></span></div>`;
}

// ─────────────────────────────── 더보기 시트
const MORE = {
  sync: { title: '기기 동기화', body: renderSync },
  rules: { title: '매매 안전장치', body: renderRules },
  bypass: { title: '예외 처리', body: renderBypass },
  assets: { title: '종목 정보', body: renderAssets },
  fx: { title: '환율', body: renderFx },
  data: { title: '데이터 백업·복원', body: renderData },
};

function openMore(kind) {
  const m = MORE[kind];
  if (!m) return;
  el('#moreTitle').textContent = m.title;
  el('#moreBody').innerHTML = m.body();
  el('#moreSheet').hidden = false;
  state.moreKind = kind;
}

function closeMore() {
  collectMore();
  el('#moreSheet').hidden = true;
  state.moreKind = null;
  save();
}

function renderSync() {
  // 계정 로그인이 준비돼 있으면 그걸 쓴다 (깃허브 계정이 없어도 되는 방식)
  if (cloud.isConfigured()) {
    const s = cloud.loadSession();
    if (s) {
      const last = store.sync?.lastSync
        ? new Date(store.sync.lastSync).toLocaleString('ko-KR') : '아직 없음';
      return `<div class="group" style="margin-top:14px">
          <div class="row"><span>
            <div class="main-txt" style="color:var(--green)">로그인됨</div>
            <div class="sub-txt">${esc(s.email || '')} · 마지막 동기화 ${esc(last)}</div></span></div>
          <button class="row tap" id="btnCloudSync"><span>지금 동기화</span><span class="chev">›</span></button>
          <button class="row tap" id="btnCloudOut"><span style="color:var(--red)">로그아웃</span></button>
        </div>
        <p class="group-hint">다른 기기에서도 같은 이메일·비밀번호로 로그인하면
          같은 데이터가 보입니다. 앱을 켤 때 자동으로 맞춰집니다.</p>`;
    }
    return `<p class="group-hint" style="padding-top:14px">
        폰과 컴퓨터에서 같은 데이터를 보려면 로그인하세요.
        처음이면 아래에 이메일·비밀번호를 넣고 <b>가입</b>을 누르면 됩니다.</p>
      <div class="group">
        <label class="row"><span>이메일</span>
          <input id="cloudEmail" type="email" inputmode="email" autocomplete="username"
                 placeholder="me@example.com"></label>
        <label class="row"><span>비밀번호</span>
          <input id="cloudPw" type="password" autocomplete="current-password"
                 placeholder="6자 이상"></label>
      </div>
      <div class="group" style="margin-top:12px">
        <button class="row tap" id="btnCloudIn"><span style="color:var(--tint)">로그인</span></button>
        <button class="row tap" id="btnCloudUp"><span>처음이에요 · 가입하기</span></button>
      </div>
      <p class="group-hint">비밀번호는 이 앱을 만든 사람도 볼 수 없습니다.
        로그인 안 해도 앱은 그냥 쓸 수 있고, 그때는 이 기기에만 저장됩니다.</p>`;
  }

  // 아직 백엔드를 안 붙였을 때
  const on = store.syncEnabled;
  const last = store.sync?.lastSync
    ? new Date(store.sync.lastSync).toLocaleString('ko-KR') : '아직 없음';
  return `<p class="group-hint" style="padding-top:14px">
      여러 기기에서 같은 데이터를 보려면 <b>계정 로그인</b>을 붙여야 합니다.
      저장소의 <b>docs/cloud-setup.md</b> 를 따라 10분이면 됩니다.
      (Supabase 무료 프로젝트 하나 만들고 web/cloud.json 채우기)</p>
    <p class="group-title">임시: 내 깃허브로 동기화</p>
    <p class="group-hint">깃허브 계정이 있는 <b>본인 기기끼리만</b> 쓰세요.
      연결 코드에 내 토큰이 들어가므로 남에게 주면 안 됩니다.</p>
    ${on ? `
      <div class="group">
        <div class="row"><span><div class="main-txt" style="color:var(--green)">연결됨</div>
          <div class="sub-txt">마지막 동기화 ${esc(last)}</div></span></div>
        <button class="row tap" id="btnSyncNow"><span>지금 동기화</span><span class="chev">›</span></button>
        <button class="row tap" id="btnShowCode"><span>연결 코드 복사</span><span class="chev">›</span></button>
        <button class="row tap" id="btnSyncOff"><span style="color:var(--red)">연결 끊기</span></button>
      </div>` : `
      <div class="group">
        <label class="row stack">
          <input id="syncCode" placeholder="연결 코드 붙여넣기" style="text-align:left" autocomplete="off">
        </label>
        <button class="row tap" id="btnJoin"><span style="color:var(--tint)">이 코드로 연결</span></button>
        <label class="row stack">
          <div class="sub-txt">또는 깃허브 토큰 (gist 권한)</div>
          <input id="syncToken" placeholder="ghp_..." style="text-align:left" autocomplete="off">
        </label>
        <button class="row tap" id="btnSyncStart"><span style="color:var(--tint)">이 기기 데이터로 시작</span></button>
      </div>`}`;
}

let pushTimer = null;

// 원격 저장소는 둘 중 켜져 있는 걸 쓴다
function remote() {
  if (cloud.isConfigured() && cloud.loadSession()) return cloud;
  if (store.syncEnabled) {
    return {
      pull: () => sync.pull(store.sync.token, store.sync.gistId),
      push: (data) => sync.push(store.sync.token, store.sync.gistId, data),
    };
  }
  return null;
}

async function syncPull({ quiet = false } = {}) {
  const r = remote();
  if (!r) return;
  try {
    const got = await r.pull();
    if (got) {
      if (store.db.isSample) { await store.clearAll(); state.db = store.db; }
      store.db = { ...sync.merge(store.db, got.data), apiKeys: store.db.apiKeys };
      state.db = store.db;
      await store.save({ snapshot: false });
      render();
    }
    store.saveSyncConfig({ lastSync: new Date().toISOString() });
    if (!quiet) toast('동기화 완료');
  } catch (e) {
    if (!quiet) toast(`동기화 실패: ${e.message}`, 'err');
    state.syncError = e.message;
  }
}

function syncPushSoon() {
  const r = remote();
  if (!r) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    try {
      await r.push(store.payload());
      store.saveSyncConfig({ lastSync: new Date().toISOString() });
      state.syncError = null;
    } catch (e) {
      state.syncError = e.message;
    }
  }, 2500);
}

const RULE_FIELDS = [
  ['cash', '예수금', '비중 계산에 포함할 현금'],
  ['max_position_weight', '1종목 비중 상한', '넘으면 매도 안내 (%)'],
  ['min_position_weight', '1종목 비중 하한', '자투리 정리 안내 (%)'],
  ['take_profit_pct', '익절 기준', '이만큼 오르면 안내 (%)'],
  ['stop_loss_pct', '손절 기준', '예: -25 (%)'],
  ['min_trade_amount', '최소 매매금액', '이보다 작으면 안내 안 함'],
];

function renderRules() {
  return `<div class="group" style="margin-top:14px">${RULE_FIELDS.map(([k, name, hint]) => `
    <label class="row">
      <span><div class="main-txt">${esc(name)}</div><div class="sub-txt">${esc(hint)}</div></span>
      <input data-rule="${k}" inputmode="decimal" value="${state.db.rules?.[k] ?? ''}"
             placeholder="—" style="max-width:110px">
    </label>`).join('')}</div>`;
}

function renderBypass() {
  const entries = state.db.bypass?.entries || [];
  const scopes = ['ticker', 'country', 'sector', 'rule', 'all'];
  return `<p class="group-hint" style="padding-top:14px">안내를 무시할 항목입니다.
    해제일이 지나면 자동으로 다시 감시합니다.</p>
    <div class="group">${entries.length ? entries.map((e, i) => `
      <div class="row stack" data-bp="${i}">
        <div style="display:flex;gap:8px;align-items:center">
          <select data-f="scope" style="text-align:left;flex:none;width:90px">
            ${scopes.map((s) => `<option ${s === e.scope ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
          <input data-f="key" value="${esc(e.key || '')}" placeholder="대상 (* = 전체)" style="text-align:left">
          <button class="btn-plain danger" data-del-bypass="${i}" style="flex:none">삭제</button>
        </div>
        <input data-f="reason" value="${esc(e.reason || '')}" placeholder="사유" style="text-align:left">
        <div style="display:flex;gap:8px;align-items:center">
          <span class="sub-txt" style="flex:none">해제일</span>
          <input data-f="until" type="date" value="${esc(e.until || '')}">
        </div>
      </div>`).join('') : '<div class="empty">예외 없음</div>'}</div>
    <div class="group-foot"><button class="btn-plain wide" id="btnAddBypass">+ 예외 추가</button></div>`;
}

function renderAssets() {
  const entries = Object.entries(state.db.assets);
  return `<p class="group-hint" style="padding-top:14px">국가·통화·섹터가 맞아야 비중이 제대로 나옵니다.</p>
    <div class="group">${entries.map(([t, a]) => `
      <div class="row stack" data-asset="${esc(t)}">
        <div style="display:flex;gap:8px;align-items:center">
          <b style="flex:1">${esc(a.name || t)}</b>
          <span class="sub-txt">${esc(t)}</span>
          <button class="btn-plain danger" data-del-asset="${esc(t)}" style="flex:none">삭제</button>
        </div>
        <div style="display:flex;gap:8px">
          <input data-f="name" value="${esc(a.name || '')}" placeholder="이름" style="text-align:left">
          <input data-f="country" value="${esc(a.country || '')}" placeholder="국가" style="max-width:60px">
          <input data-f="currency" value="${esc(a.currency || '')}" placeholder="통화" style="max-width:70px">
        </div>
        <input data-f="sector" value="${esc(a.sector || '')}" placeholder="섹터" style="text-align:left">
      </div>`).join('') || '<div class="empty">없음</div>'}</div>`;
}

function renderFx() {
  const curs = [...new Set(Object.values(state.db.assets).map((a) => a.currency))]
    .filter((c) => c && c !== state.db.baseCurrency);
  return `<p class="group-hint" style="padding-top:14px">자동으로 못 받으면 직접 넣으세요.</p>
    <div class="group">${curs.map((c) => `
      <label class="row">
        <span><div class="main-txt">1 ${esc(c)}</div>
        <div class="sub-txt">출처 ${esc(state.db.fx.sources?.[c] || '-')}</div></span>
        <input data-fx="${esc(c)}" inputmode="decimal" value="${state.db.fx.rates?.[c] ?? ''}"
               style="max-width:110px"><span class="unit">${esc(state.db.baseCurrency)}</span>
      </label>`).join('') || '<div class="empty">외화 종목이 없습니다.</div>'}</div>`;
}

function renderData() {
  const tickers = [...new Set(state.db.transactions.map((t) => t.ticker))];
  return `<p class="group-hint" style="padding-top:14px">
      브라우저 데이터를 지우면 사라집니다. 가끔 백업을 받아두세요.</p>
    <div class="group">
      <button class="row tap" id="btnExportJSON"><span>전체 백업 (JSON)</span><span class="chev">›</span></button>
      <button class="row tap" id="btnExportCSV"><span>거래내역 CSV</span><span class="chev">›</span></button>
      <button class="row tap" id="btnImport"><span>파일 불러오기</span><span class="chev">›</span></button>
      <button class="row tap" id="btnUndo"><span>되돌리기 (${store.snapshots().length})</span><span class="chev">›</span></button>
    </div>
    <p class="group-title">시세 자동수집 목록</p>
    <div class="group"><div class="row stack">
      <div class="sub-txt">깃허브의 <b>web/watchlist.json</b> 에 아래를 넣으면
        내 종목 시세를 야후에서 자동으로 받아옵니다.</div>
      <input id="watchlistOut" readonly value='${esc(JSON.stringify(tickers))}' style="text-align:left">
      <button class="btn-plain" id="btnCopyWatch" style="text-align:left">목록 복사</button>
    </div></div>
    <p class="group-title">초기화</p>
    <div class="group">
      <button class="row tap" id="btnSample"><span>예시 데이터로 되돌리기</span></button>
      <button class="row tap" id="btnClear"><span style="color:var(--red)">전체 삭제</span></button>
    </div>`;
}

function collectMore() {
  els('#moreBody input[data-rule]').forEach((i) => {
    state.db.rules[i.dataset.rule] = i.value.trim() === '' ? null : parseNum(i.value);
  });
  els('#moreBody [data-bp]').forEach((row) => {
    const g = (f) => row.querySelector(`[data-f="${f}"]`)?.value ?? '';
    state.db.bypass.entries[Number(row.dataset.bp)] = {
      scope: g('scope'), key: g('key').trim(), reason: g('reason').trim(), until: g('until'),
    };
  });
  const nextAssets = {};
  els('#moreBody [data-asset]').forEach((row) => {
    const t = row.dataset.asset;
    const g = (f) => row.querySelector(`[data-f="${f}"]`)?.value?.trim() ?? '';
    nextAssets[t] = {
      ...state.db.assets[t],
      name: g('name') || t,
      country: g('country').toUpperCase() || '??',
      currency: g('currency').toUpperCase() || 'USD',
      sector: g('sector') || '기타',
    };
  });
  if (Object.keys(nextAssets).length) Object.assign(state.db.assets, nextAssets);
  els('#moreBody input[data-fx]').forEach((i) => {
    const v = parseNum(i.value);
    if (v && state.db.fx.rates[i.dataset.fx] !== v) {
      state.db.fx.rates[i.dataset.fx] = v;
      state.db.fx.sources[i.dataset.fx] = '직접입력';
    }
  });
}

// ─────────────────────────────── 백업
function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

async function handleFile(file) {
  try {
    const text = await file.text();
    if (file.name.toLowerCase().endsWith('.json')) {
      const merge = confirm('기존 데이터에 합칠까요?\n확인 = 합치기 / 취소 = 통째로 교체');
      toast(`불러왔습니다 (거래 ${await store.importJSON(text, { merge })}건)`);
    } else {
      toast(`거래 ${await store.importCSV(text, { merge: true })}건 추가`);
    }
    render();
  } catch (e) {
    toast(`불러오기 실패: ${e.message}`, 'err');
  }
}

function renderAccountList() {
  const accounts = [...new Set(state.db.transactions.map((t) => t.account).filter(Boolean))];
  el('#accountList').innerHTML = accounts.map((a) => `<option value="${esc(a)}">`).join('');
}

// ─────────────────────────────── 이벤트
function wire() {
  els('.seg-item').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.screen)));
  el('#btnAdd').addEventListener('click', () => showScreen('trades'));
  el('#btnAddStock').addEventListener('click', () => openSheet());
  els('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  els('[data-close-more]').forEach((b) => b.addEventListener('click', closeMore));
  el('#btnSaveTx').addEventListener('click', submitTx);
  el('#btnDeleteTx').addEventListener('click', deleteTx);
  el('#txForm').addEventListener('input', updatePreview);
  el('#txForm').addEventListener('submit', (e) => { e.preventDefault(); submitTx(); });
  el('#pickedChip').addEventListener('click', () => openSheet(state.editingTxId));
  el('#pickSearch').addEventListener('input', doSearch);

  el('#pickResults').addEventListener('click', (e) => {
    const pick = e.target.closest('[data-pick]');
    if (pick) return choose(JSON.parse(pick.dataset.pick));
    const raw = e.target.closest('[data-use-raw]');
    if (raw) {
      const ticker = raw.dataset.useRaw.toUpperCase();
      const known = lookup(ticker);
      return choose(known || { ticker, name: ticker, ...guessAsset(ticker) });
    }
    return null;
  });

  el('#listPositions').addEventListener('click', (e) => {
    const row = e.target.closest('[data-ticker]');
    if (row) editPrice(row.dataset.ticker);
  });
  el('#manageList').addEventListener('click', (e) => {
    const trade = e.target.closest('[data-id]');
    if (trade) return openSheet(trade.dataset.id);

    const buy = e.target.closest('[data-buy]');
    if (buy) return openSheetFor(buy.dataset.buy, 'BUY');
    const sell = e.target.closest('[data-sell]');
    if (sell) return openSheetFor(sell.dataset.sell, 'SELL');

    const drop = e.target.closest('[data-drop]');
    if (drop) return dropStock(drop.dataset.drop);

    const head = e.target.closest('[data-stock]');
    if (head) {
      state.openStock = state.openStock === head.dataset.stock ? null : head.dataset.stock;
      ui.renderManage(state.pf, state.db, {
        search: el('#txSearch').value, open: state.openStock,
      });
    }
    return null;
  });
  el('#txSearch').addEventListener('input', () => ui.renderManage(state.pf, state.db, {
    search: el('#txSearch').value, open: state.openStock,
  }));
  el('#btnRefresh').addEventListener('click', (e) => doRefresh(e.currentTarget));
  el('#topWarn').addEventListener('click', (e) => {
    if (e.target.closest('[data-expand]')) {
      state.tipsExpanded = true;
      ui.renderTopWarnings(state.pf, state.signals, { expanded: true });
      return;
    }
    const jump = e.target.closest('[data-jump]');
    if (jump && jump.dataset.jump !== 'bypass') {
      showScreen('trades');
      state.openStock = jump.dataset.jump;
      ui.renderManage(state.pf, state.db, {
        search: el('#txSearch').value, open: state.openStock,
      });
    } else if (jump) {
      showScreen('settings');
      setTimeout(() => openMore('bypass'), 80);
    }
  });
  el('#statusBar').addEventListener('click', (e) => {
    if (e.target.closest('[data-goto-quotes]')) {
      showScreen('settings');
      setTimeout(() => el('#setQuotes').scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    }
  });

  // 설정: 값이 바뀌면 저장
  el('#screen-settings').addEventListener('change', (e) => {
    if (e.target.matches('input[data-target-dim],select[data-mode-ticker]')) {
      collectTargets(); save();
    } else if (e.target.matches('input[data-key]')) {
      state.db.apiKeys = state.db.apiKeys || {};
      state.db.apiKeys[e.target.dataset.key] = e.target.value.trim();
      save();
    }
  });
  el('#screen-settings').addEventListener('click', (e) => {
    const open = e.target.closest('[data-open]');
    if (open) return openMore(open.dataset.open);
    if (e.target.closest('#btnRefresh2')) return doRefresh(null).then(renderSettings);
    return null;
  });

  el('#moreBody').addEventListener('click', async (e) => {
    const t = e.target;

    if (t.closest('#btnCloudIn') || t.closest('#btnCloudUp')) {
      const email = el('#cloudEmail').value.trim();
      const pw = el('#cloudPw').value;
      if (!email || !pw) return toast('이메일과 비밀번호를 넣어주세요', 'err');
      const signingUp = Boolean(t.closest('#btnCloudUp'));
      try {
        toast(signingUp ? '가입하는 중...' : '로그인하는 중...');
        if (signingUp) {
          const r = await cloud.signUp(email, pw);
          if (r.needsConfirm) return toast('메일함에서 인증 링크를 눌러주세요');
        } else {
          await cloud.signIn(email, pw);
        }
        // 예시 데이터를 아직 손대지 않았다면 계정에 섞지 않고 버린다
        if (state.db.isSample) {
          await store.clearAll();
          state.db = store.db;
        }
        await syncPull({ quiet: true });
        await cloud.push(store.payload()).catch(() => {});
        el('#moreBody').innerHTML = renderSync();
        toast(signingUp ? '가입하고 연결됐습니다' : '로그인됐습니다');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (t.closest('#btnCloudSync')) {
      await syncPull();
      await cloud.push(store.payload()).catch((err) => toast(`업로드 실패: ${err.message}`, 'err'));
      el('#moreBody').innerHTML = renderSync();
      return;
    }
    if (t.closest('#btnCloudOut')) {
      if (!confirm('로그아웃합니다. 이 기기의 데이터는 그대로 남습니다.')) return;
      cloud.clearSession();
      el('#moreBody').innerHTML = renderSync();
      return;
    }
    if (t.closest('#btnSyncStart')) {
      const token = el('#syncToken').value.trim();
      if (!token) return toast('토큰을 넣어주세요', 'err');
      try {
        toast('저장소 만드는 중...');
        const gistId = await sync.createRemote(token, store.payload());
        store.saveSyncConfig({ token, gistId, lastSync: new Date().toISOString() });
        el('#moreBody').innerHTML = renderSync();
        toast('연결됐습니다');
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (t.closest('#btnJoin')) {
      try {
        const { token, gistId } = sync.readCode(el('#syncCode').value);
        store.saveSyncConfig({ token, gistId });
        await syncPull();
        el('#moreBody').innerHTML = renderSync();
      } catch (err) { toast(err.message, 'err'); }
      return;
    }
    if (t.closest('#btnSyncNow')) {
      await syncPull();
      await sync.push(store.sync.token, store.sync.gistId, store.payload())
        .catch((err) => toast(`업로드 실패: ${err.message}`, 'err'));
      el('#moreBody').innerHTML = renderSync();
      return;
    }
    if (t.closest('#btnShowCode')) {
      const code = sync.makeCode(store.sync.token, store.sync.gistId);
      navigator.clipboard?.writeText(code).then(
        () => toast('연결 코드를 복사했습니다'),
        () => prompt('이 코드를 다른 기기에 붙여넣으세요', code),
      );
      return;
    }
    if (t.closest('#btnSyncOff')) {
      if (!confirm('이 기기의 연결을 끊습니다. 데이터는 그대로 남습니다.')) return;
      store.clearSyncConfig();
      el('#moreBody').innerHTML = renderSync();
      return;
    }

    if (t.closest('#btnAddBypass')) {
      collectMore();
      state.db.bypass.entries.push({ scope: 'ticker', key: '', reason: '', until: '' });
      el('#moreBody').innerHTML = renderBypass(); return;
    }
    const delBp = t.closest('[data-del-bypass]');
    if (delBp) {
      collectMore();
      state.db.bypass.entries.splice(Number(delBp.dataset.delBypass), 1);
      el('#moreBody').innerHTML = renderBypass(); return;
    }
    const delAsset = t.closest('[data-del-asset]');
    if (delAsset) {
      const ticker = delAsset.dataset.delAsset;
      if (state.db.transactions.some((x) => x.ticker === ticker)
        && !confirm(`${ticker} 은 거래 내역이 있습니다. 종목 정보만 지울까요?`)) return;
      store.deleteAsset(ticker);
      el('#moreBody').innerHTML = renderAssets(); return;
    }
    if (t.closest('#btnExportJSON')) {
      download(`찬홍팍_백업_${stamp()}.json`, store.exportJSON()); toast('백업 파일 저장'); return;
    }
    if (t.closest('#btnExportCSV')) {
      download(`거래내역_${stamp()}.csv`, store.exportCSV(), 'text/csv'); return;
    }
    if (t.closest('#btnImport')) { el('#fileInput').click(); return; }
    if (t.closest('#btnCopyWatch')) {
      const box = el('#watchlistOut');
      navigator.clipboard?.writeText(box.value).then(
        () => toast('복사했습니다'),
        () => { box.select(); toast('길게 눌러 복사하세요'); },
      );
      return;
    }
    if (t.closest('#btnUndo')) {
      const snaps = store.snapshots();
      if (!snaps.length) { toast('되돌릴 지점이 없습니다', 'err'); return; }
      if (!confirm(`${new Date(snaps[0].at).toLocaleString('ko-KR')} 시점으로 되돌릴까요?`)) return;
      store.restoreSnapshot(0).then(() => { el('#moreSheet').hidden = true; render(); toast('되돌렸습니다'); });
      return;
    }
    if (t.closest('#btnSample')) {
      if (!confirm('예시 데이터로 되돌립니다. 지금 데이터는 되돌리기 지점에 남습니다.')) return;
      store.resetToSample().then(() => { el('#moreSheet').hidden = true; render(); });
      return;
    }
    if (t.closest('#btnClear')) {
      if (!confirm('모든 데이터를 지웁니다. 계속할까요?')) return;
      if (!confirm('정말 지울까요? 백업을 먼저 받아두세요.')) return;
      store.clearAll().then(() => { el('#moreSheet').hidden = true; render(); toast('전부 지웠습니다'); });
    }
  });

  el('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = '';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el('#moreSheet').hidden) closeMore();
    else if (!el('#sheet').hidden) closeSheet();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    el('#btnInstall').hidden = false;
  });
  el('#btnInstall').addEventListener('click', async () => {
    if (state.installPrompt) {
      state.installPrompt.prompt();
      const { outcome } = await state.installPrompt.userChoice;
      if (outcome === 'accepted') el('#btnInstall').hidden = true;
      state.installPrompt = null;
    } else {
      alert('아이폰(사파리): 아래 공유 버튼 → "홈 화면에 추가"\n'
        + '안드로이드(크롬): 오른쪽 위 ⋮ → "앱 설치"');
    }
  });
  window.addEventListener('appinstalled', () => { el('#btnInstall').hidden = true; });
}

// ─────────────────────────────── 시작
async function main() {
  await store.init();
  state.db = store.db;
  wire();
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (!standalone) el('#btnInstall').hidden = false;

  render();
  if (store.isFirstRun) toast('예시 데이터로 시작합니다');
  loadSiteQuotes();
  cloud.loadConfig().then(() => { if (remote()) syncPull({ quiet: true }); });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

main();
