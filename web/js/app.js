// 앱 진입점 - 상태를 들고 화면을 갱신하고 이벤트를 처리한다.

import { Store, guessAsset, naturalKey } from './store.js';
import { buildPortfolio, DIMENSIONS } from './engine.js';
import { BypassRegistry, evaluate } from './rules.js';
import { providerStatus, refreshQuotes, detectServer } from './quotes.js';
import * as ui from './ui.js';
import {
  el, els, esc, parseNum, toast, today, DIM_LABELS, MODE_LABELS, price as fmtPrice,
} from './util.js';

const store = new Store();
const state = {
  db: null,
  pf: null,
  signals: [],
  bypassReg: null,
  dim: 'country',
  screen: 'home',
  serverMode: false,
  editingTxId: null,
  installPrompt: null,
};

// ---------------------------------------------------------------- 렌더
function recompute() {
  state.pf = buildPortfolio(state.db);
  const disabled = !el('#chkBypass').checked;
  const reg = new BypassRegistry(state.db, { disabled });
  const r = evaluate(state.pf, state.db, reg);
  state.signals = r.signals;
  state.bypassReg = r.bypass;
}

function render() {
  recompute();
  const { pf, db } = state;
  ui.renderTopSub(pf, db, state.serverMode);
  ui.renderKpis(pf);
  ui.renderPositions(pf);
  ui.renderDimChips(pf, db, state.dim);
  ui.renderBreakdown(pf, db, state.dim);
  ui.renderPlan(pf, state.signals);
  ui.renderSignals(pf, state.signals);
  ui.renderAlerts(pf, db, extraAlerts());
  ui.renderTransactions(db, {
    search: el('#txSearch').value, ticker: el('#txFilterTicker').value,
  });
  renderTickerOptions();
  if (state.screen === 'settings') renderSettings();
}

function extraAlerts() {
  const out = [];
  const unused = (state.bypassReg?.unused || []).filter((e) => e.key);
  if (unused.length) {
    out.push({
      kind: 'info',
      html: `이번에 걸리지 않은 예외 설정: <b>${esc(unused.map((e) => `${e.scope}:${e.key}`).join(', '))}</b>
             — 오타이거나 기간이 지난 항목일 수 있습니다.`,
    });
  }
  if (store.recoveredFromMirror) {
    out.push({ kind: 'info', html: '브라우저 저장소가 비어 있어 <b>백업 사본에서 복구</b>했습니다.' });
  }
  return out;
}

async function save() {
  const err = await store.save();
  if (err) toast('저장 실패 - 저장공간이 부족할 수 있습니다', 'err');
  render();
}

// ---------------------------------------------------------------- 탭
function showScreen(name) {
  state.screen = name;
  els('.tab').forEach((t) => t.classList.toggle('active', t.dataset.screen === name));
  els('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
  window.scrollTo({ top: 0 });
  if (name === 'settings') renderSettings();
}

// ---------------------------------------------------------------- 거래 입력 시트
function openSheet(txId = null) {
  state.editingTxId = txId;
  const form = el('#txForm');
  const tx = txId ? state.db.transactions.find((t) => t.id === txId) : null;
  el('#sheetTitle').textContent = tx ? '거래 수정' : '거래 추가';
  el('#btnDeleteTx').hidden = !tx;
  form.reset();
  form.date.value = tx?.date || today();
  form.ticker.value = tx?.ticker || '';
  form.side.value = tx?.side || 'BUY';
  form.quantity.value = tx ? tx.quantity : '';
  form.price.value = tx ? tx.price : '';
  form.fee.value = tx?.fee || '';
  form.account.value = tx?.account || lastAccount();
  form.note.value = tx?.note || '';
  el('#sheet').hidden = false;
  updatePreview();
  setTimeout(() => (tx ? form.quantity : form.ticker).focus(), 60);
}

function closeSheet() {
  el('#sheet').hidden = true;
  state.editingTxId = null;
}

function lastAccount() {
  const t = state.db.transactions[state.db.transactions.length - 1];
  return t?.account || '';
}

function updatePreview() {
  const form = el('#txForm');
  const ticker = form.ticker.value.trim();
  const asset = state.db.assets[ticker] || (ticker ? guessAsset(ticker) : null);
  const cur = asset?.currency || '';
  el('#priceLabel').firstChild.textContent = cur ? `단가 (${cur})` : '단가';
  const qty = parseNum(form.quantity.value);
  const price = parseNum(form.price.value);
  const fee = parseNum(form.fee.value);
  if (!ticker || !qty || !price) { el('#txPreview').textContent = ''; return; }
  const total = qty * price + (form.side.value === 'BUY' ? fee : -fee);
  const known = state.db.assets[ticker];
  el('#txPreview').innerHTML = `${form.side.value === 'BUY' ? '매수' : '매도'}금액 약
    <b>${fmtPrice(total, cur)} ${esc(cur)}</b>
    ${known ? '' : ` · <span class="mut">새 종목이라 ${esc(asset.country)}/${esc(cur)} 로 자동 등록됩니다 (설정에서 수정 가능)</span>`}`;
}

function submitTx(e) {
  e.preventDefault();
  const f = e.target;
  const ticker = f.ticker.value.trim();
  const qty = Math.abs(parseNum(f.quantity.value));
  const price = parseNum(f.price.value);
  if (!ticker) return toast('종목을 입력하세요', 'err');
  if (!qty) return toast('수량을 입력하세요', 'err');
  if (!price) return toast('단가를 입력하세요', 'err');

  const row = {
    date: f.date.value || today(),
    ticker,
    side: f.side.value,
    quantity: qty,
    price,
    fee: parseNum(f.fee.value),
    account: f.account.value.trim() || '기본',
    note: f.note.value.trim(),
  };

  if (!state.db.assets[ticker]) {
    state.db.assets[ticker] = guessAsset(ticker);
    toast(`새 종목 ${ticker} 등록 - 설정에서 섹터를 지정하세요`);
  }
  if (state.editingTxId) {
    store.updateTransaction(state.editingTxId, row);
  } else {
    const dup = state.db.transactions.find((t) => naturalKey(t) === naturalKey(row));
    if (dup && !confirm('같은 내용의 거래가 이미 있습니다. 그래도 추가할까요?')) return;
    store.addTransaction(row);
  }
  closeSheet();
  save();
  toast(state.editingTxId ? '수정했습니다' : '추가했습니다');
}

function deleteTx() {
  if (!state.editingTxId) return;
  if (!confirm('이 거래를 삭제할까요?')) return;
  store.deleteTransaction(state.editingTxId);
  closeSheet();
  save();
  toast('삭제했습니다');
}

// ---------------------------------------------------------------- 현재가 직접 입력
function editPrice(ticker) {
  const asset = state.db.assets[ticker] || guessAsset(ticker);
  const q = state.db.quotes[ticker];
  const input = prompt(
    `${asset.name || ticker} 현재가 (${asset.currency})`,
    q?.price != null ? String(q.price) : '',
  );
  if (input === null) return;
  const v = parseNum(input);
  if (!v) return toast('숫자를 넣어주세요', 'err');
  store.setQuote(ticker, {
    price: v,
    previousClose: q?.previousClose ?? null,
    currency: asset.currency,
    source: '직접입력',
    asOf: new Date().toISOString(),
    stale: false,
  });
  save();
  toast('현재가를 반영했습니다');
}

// ---------------------------------------------------------------- 시세 새로고침
async function doRefresh() {
  const btn = el('#btnRefresh');
  const label = btn.textContent;
  btn.disabled = true;
  try {
    const r = await refreshQuotes(state.db, { onProgress: (m) => { btn.textContent = m; } });
    let n = 0;
    for (const [ticker, q] of Object.entries(r.quotes)) { store.setQuote(ticker, q); n += 1; }
    if (r.fx?.rates) {
      state.db.fx = {
        base: state.db.baseCurrency,
        rates: { ...state.db.fx.rates, ...r.fx.rates },
        sources: { ...state.db.fx.sources, ...(r.fx.sources || {}) },
        asOf: new Date().toISOString(),
      };
    }
    await save();
    state.lastFetchLog = r.log;
    toast(n ? `${n}종목 시세를 받았습니다` : '받아온 시세가 없습니다 - 설정에서 API 키를 넣거나 직접 입력하세요',
      n ? 'ok' : 'err');
  } catch (e) {
    toast(`시세 갱신 실패: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// ---------------------------------------------------------------- 설정 화면
function renderSettings() {
  renderTargetEditor();
  renderRulesEditor();
  renderBypassEditor();
  renderAssetEditor();
  renderFxEditor();
  renderApiKeyEditor();
  renderStorageInfo();
}

function keysForDim(dim) {
  const set = new Set((state.pf?.breakdowns?.[dim] || []).map((b) => b.key));
  Object.keys(state.db.targets?.[dim]?.items || {}).forEach((k) => set.add(k));
  return [...set].sort();
}

function renderTargetEditor() {
  const box = el('#targetEditor');
  const groups = Object.entries(state.db.targets || {});
  if (!groups.length) {
    box.innerHTML = '<div class="empty">아직 목표가 없습니다. 아래 버튼으로 추가하세요.</div>';
    return;
  }
  box.innerHTML = groups.map(([dim, g]) => {
    const rows = Object.entries(g.items || {}).map(([key, item]) => {
      const mode = item.mode || 'weight';
      const unit = mode === 'weight' ? '%' : mode === 'shares' ? '주' : state.db.baseCurrency;
      return `<div class="row-edit" data-dim="${esc(dim)}" data-key="${esc(key)}">
        <label class="full">대상
          <select data-f="key">
            ${keysForDim(dim).map((k) => `<option ${k === key ? 'selected' : ''}>${esc(k)}</option>`).join('')}
            ${keysForDim(dim).includes(key) ? '' : `<option selected>${esc(key)}</option>`}
          </select>
        </label>
        <label>기준
          <select data-f="mode">
            ${Object.entries(MODE_LABELS).map(([m, l]) => `<option value="${m}" ${m === mode ? 'selected' : ''}>${esc(l)}</option>`).join('')}
          </select>
        </label>
        <label>목표 (${esc(unit)})
          <input data-f="target" inputmode="decimal" value="${item.target ?? ''}">
        </label>
        <label>허용오차 (${mode === 'weight' ? '%p' : '%'})
          <input data-f="tolerance" inputmode="decimal" value="${item.tolerance ?? ''}" placeholder="${g.tolerance ?? ''}">
        </label>
        <label>하한 / 상한
          <span style="display:flex;gap:6px">
            <input data-f="min" inputmode="decimal" value="${item.min ?? ''}" placeholder="자동">
            <input data-f="max" inputmode="decimal" value="${item.max ?? ''}" placeholder="자동">
          </span>
        </label>
        <label class="full">메모<input data-f="note" value="${esc(item.note || '')}"></label>
        <button class="btn small danger del" data-del-target>삭제</button>
      </div>`;
    }).join('');
    return `<section style="margin-bottom:14px">
      <h3 style="font-size:14px;margin-bottom:6px">${esc(DIM_LABELS[dim] || dim)}별 목표
        <label class="switch" style="float:right">
          <input type="checkbox" data-group-enabled="${esc(dim)}" ${g.enabled === false ? '' : 'checked'}>
          <span>사용</span></label>
      </h3>
      ${rows || '<p class="hint">항목이 없습니다.</p>'}
    </section>`;
  }).join('');
}

function collectTargets() {
  els('#targetEditor .row-edit').forEach((row) => {
    const { dim, key } = row.dataset;
    const g = state.db.targets[dim];
    if (!g) return;
    const get = (f) => row.querySelector(`[data-f="${f}"]`)?.value ?? '';
    const newKey = get('key').trim() || key;
    const item = {
      mode: get('mode') || 'weight',
      target: get('target') === '' ? null : parseNum(get('target')),
      tolerance: get('tolerance') === '' ? null : parseNum(get('tolerance')),
      min: get('min') === '' ? null : parseNum(get('min')),
      max: get('max') === '' ? null : parseNum(get('max')),
      note: get('note').trim(),
    };
    if (newKey !== key) delete g.items[key];
    g.items[newKey] = item;
  });
  els('#targetEditor [data-group-enabled]').forEach((c) => {
    const dim = c.dataset.groupEnabled;
    if (state.db.targets[dim]) state.db.targets[dim].enabled = c.checked;
  });
}

const RULE_FIELDS = [
  ['cash', '예수금(현금)', '비중 계산에 포함할 현금'],
  ['max_position_weight', '1종목 비중 상한 %', '넘으면 매도 안내'],
  ['min_position_weight', '1종목 비중 하한 %', '자투리 종목 정리 안내'],
  ['take_profit_pct', '익절 기준 수익률 %', '예: 60'],
  ['stop_loss_pct', '손절 기준 수익률 %', '예: -25'],
  ['min_trade_amount', '최소 매매금액', '이보다 작으면 참고로만 표시'],
];

function renderRulesEditor() {
  el('#rulesEditor').innerHTML = RULE_FIELDS.map(([k, label, hint]) => `
    <label>${esc(label)}
      <input data-rule="${k}" inputmode="decimal" value="${state.db.rules?.[k] ?? ''}" placeholder="${esc(hint)}">
    </label>`).join('');
}

function collectRules() {
  els('#rulesEditor input[data-rule]').forEach((i) => {
    const k = i.dataset.rule;
    state.db.rules[k] = i.value.trim() === '' ? null : parseNum(i.value);
  });
  state.db.rules.cash = state.db.rules.cash || 0;
  state.db.rules.min_trade_amount = state.db.rules.min_trade_amount || 0;
}

function renderBypassEditor() {
  const scopes = ['ticker', 'country', 'sector', 'currency', 'account', 'asset_class', 'tag', 'rule', 'all'];
  const entries = state.db.bypass?.entries || [];
  el('#bypassEditor').innerHTML = `
    <label class="switch" style="margin-bottom:8px">
      <input type="checkbox" id="bypassEnabled" ${state.db.bypass?.enabled ? 'checked' : ''}>
      <span>예외 기능 사용</span>
    </label>
    ${entries.length ? entries.map((e, i) => `
      <div class="row-edit" data-bp="${i}">
        <label>범위
          <select data-f="scope">
            ${scopes.map((s) => `<option ${s === e.scope ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </label>
        <label>대상 (* = 전체)<input data-f="key" value="${esc(e.key || '')}"></label>
        <label class="full">사유<input data-f="reason" value="${esc(e.reason || '')}"></label>
        <label>해제일 (비우면 계속)<input data-f="until" type="date" value="${esc(e.until || '')}"></label>
        <button class="btn small danger del" data-del-bypass="${i}">삭제</button>
      </div>`).join('') : '<p class="hint">예외 없음 - 모든 안내가 그대로 나옵니다.</p>'}`;
}

function collectBypass() {
  const enabled = el('#bypassEnabled');
  if (enabled) state.db.bypass.enabled = enabled.checked;
  els('#bypassEditor .row-edit').forEach((row) => {
    const i = Number(row.dataset.bp);
    const get = (f) => row.querySelector(`[data-f="${f}"]`)?.value ?? '';
    state.db.bypass.entries[i] = {
      scope: get('scope'), key: get('key').trim(),
      reason: get('reason').trim(), until: get('until'),
    };
  });
}

function renderAssetEditor() {
  const entries = Object.entries(state.db.assets);
  el('#assetEditor').innerHTML = entries.length ? entries.map(([ticker, a]) => `
    <div class="row-edit" data-asset="${esc(ticker)}">
      <label>티커<input data-f="ticker" value="${esc(ticker)}"></label>
      <label>이름<input data-f="name" value="${esc(a.name || '')}"></label>
      <label>국가<input data-f="country" value="${esc(a.country || '')}" placeholder="KR/US/VN"></label>
      <label>통화<input data-f="currency" value="${esc(a.currency || '')}" placeholder="KRW/USD/VND"></label>
      <label>섹터<input data-f="sector" value="${esc(a.sector || '')}"></label>
      <label>자산군<input data-f="asset_class" value="${esc(a.asset_class || '주식')}"></label>
      <label class="full">태그 (쉼표로 구분)<input data-f="tags" value="${esc((a.tags || []).join(', '))}"></label>
      <button class="btn small danger del" data-del-asset="${esc(ticker)}">삭제</button>
    </div>`).join('') : '<p class="hint">등록된 종목이 없습니다.</p>';
}

function collectAssets() {
  const next = {};
  els('#assetEditor .row-edit').forEach((row) => {
    const get = (f) => row.querySelector(`[data-f="${f}"]`)?.value?.trim() ?? '';
    const ticker = get('ticker');
    if (!ticker) return;
    next[ticker] = {
      name: get('name') || ticker,
      country: get('country').toUpperCase() || '??',
      currency: get('currency').toUpperCase() || 'USD',
      sector: get('sector') || '기타',
      asset_class: get('asset_class') || '주식',
      tags: get('tags').split(',').map((t) => t.trim()).filter(Boolean),
    };
  });
  if (Object.keys(next).length) state.db.assets = next;
}

function renderFxEditor() {
  const currencies = [...new Set(Object.values(state.db.assets).map((a) => a.currency))]
    .filter((c) => c && c !== state.db.baseCurrency);
  el('#fxEditor').innerHTML = currencies.length ? currencies.map((c) => `
    <label>1 ${esc(c)} = ? ${esc(state.db.baseCurrency)}
      <input data-fx="${esc(c)}" inputmode="decimal" value="${state.db.fx.rates?.[c] ?? ''}">
      <span class="hint" style="margin:0">출처: ${esc(state.db.fx.sources?.[c] || '-')}</span>
    </label>`).join('') : '<p class="hint">외화 종목이 없습니다.</p>';
}

function collectFx() {
  els('#fxEditor input[data-fx]').forEach((i) => {
    const c = i.dataset.fx;
    const v = parseNum(i.value);
    if (v) {
      if (state.db.fx.rates[c] !== v) state.db.fx.sources[c] = '직접입력';
      state.db.fx.rates[c] = v;
    }
  });
}

const KEY_FIELDS = [
  ['twelvedata', 'Twelve Data', 'twelvedata.com - 무료 800회/일, 한국·베트남도 지원'],
  ['finnhub', 'Finnhub', 'finnhub.io - 무료 60회/분, 미국 주식'],
  ['alphavantage', 'Alpha Vantage', 'alphavantage.co - 무료 25회/일'],
];

function renderApiKeyEditor() {
  el('#apiKeyEditor').innerHTML = KEY_FIELDS.map(([k, label, hint]) => `
    <label class="span2">${esc(label)}
      <input data-key="${k}" value="${esc(state.db.apiKeys?.[k] || '')}" placeholder="${esc(hint)}" autocomplete="off">
    </label>`).join('');
  el('#providerStatus').innerHTML = providerStatus(state.db.apiKeys || {}).map((p) => `
    <div class="prov"><span>${esc(p.label)} <span class="mut">· ${esc(p.scope)}</span></span>
      <span class="${p.ready ? 'up' : 'mut'}">${p.ready ? '사용 가능' : `키 필요`}</span></div>`).join('')
    + `<div class="prov"><span>로컬 서버 <span class="mut">· PC 에서 python3 -m portfolio serve</span></span>
        <span class="${state.serverMode ? 'up' : 'mut'}">${state.serverMode ? '연결됨' : '미연결'}</span></div>`;
}

function collectApiKeys() {
  state.db.apiKeys = state.db.apiKeys || {};
  els('#apiKeyEditor input[data-key]').forEach((i) => { state.db.apiKeys[i.dataset.key] = i.value.trim(); });
}

async function renderStorageInfo() {
  const info = await store.storageInfo();
  const mb = (v) => (v ? `${(v / 1024 / 1024).toFixed(1)}MB` : '?');
  const snaps = store.snapshots().length;
  el('#storageInfo').innerHTML =
    `저장소 사용 ${mb(info.usage)} / ${mb(info.quota)} · `
    + `영구보관 ${info.persisted ? '<b class="up">켜짐</b> (브라우저가 임의로 지우지 않음)' : '<b>미보장</b>'} · `
    + `되돌리기 지점 ${snaps}개`;
}

function collectSettings() {
  collectTargets(); collectRules(); collectBypass();
  collectAssets(); collectFx(); collectApiKeys();
}

// ---------------------------------------------------------------- 백업
function download(name, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() { return new Date().toISOString().slice(0, 10); }

async function handleFile(file) {
  const text = await file.text();
  try {
    if (file.name.toLowerCase().endsWith('.json')) {
      const merge = confirm('기존 데이터에 합칠까요?\n확인 = 합치기 / 취소 = 통째로 교체');
      const n = await store.importJSON(text, { merge });
      toast(`불러왔습니다 (거래 ${n}건)`);
    } else {
      const n = await store.importCSV(text, { merge: true });
      toast(`거래 ${n}건 추가했습니다`);
    }
    render();
  } catch (e) {
    toast(`불러오기 실패: ${e.message}`, 'err');
  }
}

// ---------------------------------------------------------------- 티커 목록
function renderTickerOptions() {
  const tickers = Object.keys(state.db.assets).sort();
  el('#tickerList').innerHTML = tickers
    .map((t) => `<option value="${esc(t)}">${esc(state.db.assets[t].name || t)}</option>`).join('');
  const accounts = [...new Set(state.db.transactions.map((t) => t.account).filter(Boolean))];
  el('#accountList').innerHTML = accounts.map((a) => `<option value="${esc(a)}">`).join('');

  const sel = el('#txFilterTicker');
  const cur = sel.value;
  sel.innerHTML = '<option value="">전체 종목</option>'
    + tickers.map((t) => `<option value="${esc(t)}" ${t === cur ? 'selected' : ''}>${esc(state.db.assets[t].name || t)}</option>`).join('');
}

// ---------------------------------------------------------------- 이벤트 연결
function wire() {
  els('.tab').forEach((t) => t.addEventListener('click', () => showScreen(t.dataset.screen)));
  el('#btnAdd').addEventListener('click', () => openSheet());
  el('#btnAdd2').addEventListener('click', () => openSheet());
  els('[data-close]').forEach((b) => b.addEventListener('click', closeSheet));
  el('#txForm').addEventListener('submit', submitTx);
  el('#txForm').addEventListener('input', updatePreview);
  el('#btnDeleteTx').addEventListener('click', deleteTx);
  el('#btnRefresh').addEventListener('click', doRefresh);
  el('#chkBypass').addEventListener('change', render);

  el('#dimChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-dim]');
    if (!chip) return;
    state.dim = chip.dataset.dim;
    ui.renderDimChips(state.pf, state.db, state.dim);
    ui.renderBreakdown(state.pf, state.db, state.dim);
  });

  el('#tblPositions').addEventListener('click', (e) => {
    const t = e.target.closest('[data-edit-price]');
    if (t) editPrice(t.dataset.editPrice);
  });

  el('#txList').addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (row) openSheet(row.dataset.id);
  });
  el('#txSearch').addEventListener('input', () => ui.renderTransactions(state.db, {
    search: el('#txSearch').value, ticker: el('#txFilterTicker').value,
  }));
  el('#txFilterTicker').addEventListener('change', () => ui.renderTransactions(state.db, {
    search: el('#txSearch').value, ticker: el('#txFilterTicker').value,
  }));

  // 설정: 입력이 끝나면 저장
  el('#screen-settings').addEventListener('change', (e) => {
    if (e.target.closest('input,select')) { collectSettings(); save(); }
  });

  el('#screen-settings').addEventListener('click', (e) => {
    const delTarget = e.target.closest('[data-del-target]');
    if (delTarget) {
      const row = delTarget.closest('.row-edit');
      delete state.db.targets[row.dataset.dim].items[row.dataset.key];
      save(); return;
    }
    const delBypass = e.target.closest('[data-del-bypass]');
    if (delBypass) {
      state.db.bypass.entries.splice(Number(delBypass.dataset.delBypass), 1);
      save(); return;
    }
    const delAsset = e.target.closest('[data-del-asset]');
    if (delAsset) {
      const ticker = delAsset.dataset.delAsset;
      const used = state.db.transactions.some((t) => t.ticker === ticker);
      if (used && !confirm(`${ticker} 은 거래 내역이 있습니다. 종목 정보만 지울까요?`)) return;
      store.deleteAsset(ticker);
      save();
    }
  });

  el('#btnAddTarget').addEventListener('click', () => {
    const dim = prompt(`어느 축에 목표를 걸까요?\n${DIMENSIONS.join(' / ')}`, 'country');
    if (!dim || !DIMENSIONS.includes(dim)) return;
    const key = prompt(`${DIM_LABELS[dim]} 대상 (예: ${keysForDim(dim)[0] || 'KR'})`, keysForDim(dim)[0] || '');
    if (!key) return;
    state.db.targets[dim] = state.db.targets[dim] || { enabled: true, tolerance: 5, items: {} };
    state.db.targets[dim].items[key] = { mode: 'weight', target: 10 };
    save();
  });

  el('#btnAddBypass').addEventListener('click', () => {
    state.db.bypass.entries.push({ scope: 'ticker', key: '', reason: '', until: '' });
    save();
  });

  el('#btnAddAsset').addEventListener('click', () => {
    const ticker = prompt('티커 (예: AAPL, 005930.KS, FPT.VN)');
    if (!ticker) return;
    state.db.assets[ticker.trim()] = guessAsset(ticker.trim());
    save();
  });

  el('#btnExportJSON').addEventListener('click', () => {
    download(`내주식_백업_${stamp()}.json`, store.exportJSON());
    toast('백업 파일을 내려받았습니다');
  });
  el('#btnExportCSV').addEventListener('click', () => {
    download(`거래내역_${stamp()}.csv`, store.exportCSV(), 'text/csv');
  });
  el('#btnImport').addEventListener('click', () => el('#fileInput').click());
  el('#fileInput').addEventListener('change', (e) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
    e.target.value = '';
  });
  el('#btnUndo').addEventListener('click', async () => {
    const snaps = store.snapshots();
    if (!snaps.length) return toast('되돌릴 지점이 없습니다', 'err');
    if (!confirm(`${new Date(snaps[0].at).toLocaleString('ko-KR')} 시점으로 되돌릴까요?`)) return;
    await store.restoreSnapshot(0);
    render();
    toast('되돌렸습니다');
  });
  el('#btnSample').addEventListener('click', async () => {
    if (!confirm('예시 데이터로 되돌립니다. 지금 데이터는 되돌리기 지점에 남습니다.')) return;
    await store.resetToSample(); render(); toast('예시 데이터로 되돌렸습니다');
  });
  el('#btnClear').addEventListener('click', async () => {
    if (!confirm('모든 데이터를 지웁니다. 계속할까요?')) return;
    if (!confirm('정말 지울까요? 백업을 먼저 받아두세요.')) return;
    await store.clearAll(); render(); toast('전부 지웠습니다');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('#sheet').hidden) closeSheet();
  });

  // 앱 설치
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
      alert('아이폰(Safari): 아래 공유 버튼 → "홈 화면에 추가"\n'
        + '안드로이드(Chrome): 오른쪽 위 ⋮ → "앱 설치" 또는 "홈 화면에 추가"');
    }
  });
  window.addEventListener('appinstalled', () => { el('#btnInstall').hidden = true; });
}

// ---------------------------------------------------------------- 시작
async function main() {
  await store.init();
  state.db = store.db;
  wire();

  // iOS 등 beforeinstallprompt 가 없는 브라우저에서도 설치 안내는 보여준다
  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  if (!standalone) el('#btnInstall').hidden = false;

  render();
  if (store.isFirstRun) {
    toast('예시 데이터로 시작합니다. 설정에서 바꿀 수 있어요.');
  }

  detectServer().then((ok) => {
    state.serverMode = ok;
    ui.renderTopSub(state.pf, state.db, ok);
    if (state.screen === 'settings') renderApiKeyEditor();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* file:// 등에서는 무시 */ });
  }
}

main();
