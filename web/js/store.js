// 영속 저장소.
// 폰에서 쓰는 앱이라 "데이터가 날아가지 않는 것"이 제일 중요해서 3중으로 막는다.
//   1) localStorage  : 기본 저장소 (동기, 빠름)
//   2) IndexedDB     : 같은 내용을 한 번 더 (localStorage 만 날아가는 사고 대비)
//   3) 스냅샷 5개    : 저장할 때마다 직전 상태를 남겨서 되돌리기 가능
// 여기에 navigator.storage.persist() 로 브라우저 자동 삭제(용량 정리) 대상에서 뺀다.
// 그래도 "사이트 데이터 삭제" 나 앱 삭제는 못 막으므로 백업(JSON 내보내기)을 권한다.

import { uid, today } from './util.js';

const KEY = 'chanhong.portfolio.v1';
// 동기화 설정(토큰 등)은 절대 동기화 대상 데이터에 섞이면 안 되므로 따로 보관한다
const SYNC_KEY = 'chanhong.sync';
const SNAP_KEY = 'chanhong.portfolio.snapshots';
const MAX_SNAPSHOTS = 5;
const DB_NAME = 'chanhong-portfolio';
const STORE = 'kv';

export const SCHEMA_VERSION = 1;

// ---------------------------------------------------------------- 기본값
export function emptyDB() {
  return {
    version: SCHEMA_VERSION,
    baseCurrency: 'KRW',
    assets: {},
    transactions: [],
    targets: {},
    rules: {
      cash: 0,
      max_position_weight: null,
      min_position_weight: null,
      take_profit_pct: null,
      stop_loss_pct: null,
      min_trade_amount: 0,
    },
    bypass: { enabled: true, entries: [] },
    quotes: {},
    fx: { base: 'KRW', rates: { KRW: 1 }, sources: { KRW: 'base' }, asOf: null },
    apiKeys: {},
    deletedIds: [],   // 지운 거래 기록. 다른 기기에서 되살아나는 걸 막는다
    updatedAt: null,
  };
}

// 처음 켰을 때 들어가는 예시 데이터 (삼성/LG/애플/아마존/테슬라/베트남 FPT)
export function sampleDB() {
  const db = emptyDB();
  db.assets = {
    '005930.KS': { name: '삼성전자', country: 'KR', currency: 'KRW', sector: '반도체', asset_class: '주식', tags: ['대형주', '배당'] },
    '066570.KS': { name: 'LG전자', country: 'KR', currency: 'KRW', sector: '가전/전장', asset_class: '주식', tags: ['대형주', '배당'] },
    AAPL: { name: '애플', country: 'US', currency: 'USD', sector: 'IT하드웨어', asset_class: '주식', tags: ['대형주', '빅테크'] },
    AMZN: { name: '아마존', country: 'US', currency: 'USD', sector: '소비재/클라우드', asset_class: '주식', tags: ['대형주', '빅테크'] },
    TSLA: { name: '테슬라', country: 'US', currency: 'USD', sector: '자동차', asset_class: '주식', tags: ['성장주', '고변동'] },
    'FPT.VN': { name: 'FPT', country: 'VN', currency: 'VND', sector: 'IT서비스', asset_class: '주식', tags: ['신흥국', '성장주'] },
  };
  const tx = (date, ticker, side, quantity, price, fee, account, note = '') =>
    ({ id: uid(), date, ticker, side, quantity, price, fee, account, note });
  db.transactions = [
    tx('2022-11-04', 'AAPL', 'BUY', 20, 138.5, 2.08, '미래에셋', '장기보유'),
    tx('2023-02-10', 'AMZN', 'BUY', 15, 102.3, 1.53, '미래에셋', '분할매수 1차'),
    tx('2023-03-15', '005930.KS', 'BUY', 50, 60500, 4537, '키움', '첫 매수'),
    tx('2023-06-02', 'TSLA', 'BUY', 12, 213.97, 1.92, '미래에셋', ''),
    tx('2023-08-21', '066570.KS', 'BUY', 15, 105000, 2362, '키움', '배당목적'),
    tx('2024-01-10', '005930.KS', 'BUY', 30, 73000, 3285, '키움', '추가매수'),
    tx('2024-03-05', 'FPT.VN', 'BUY', 500, 96000, 144000, '베트남계좌', '베트남 IT 대표주'),
    tx('2024-05-20', 'AAPL', 'BUY', 10, 190.2, 1.43, '미래에셋', '분할매수 2차'),
    tx('2025-02-14', 'TSLA', 'SELL', 4, 355.0, 1.07, '미래에셋', '일부 익절'),
  ];
  db.targets = {
    country: {
      enabled: true, tolerance: 5,
      items: {
        KR: { mode: 'weight', target: 30 },
        US: { mode: 'weight', target: 55 },
        VN: { mode: 'weight', target: 15 },
      },
    },
    sector: {
      enabled: true, tolerance: 8,
      items: {
        반도체: { mode: 'weight', target: 20 },
        '가전/전장': { mode: 'weight', target: 10 },
        IT하드웨어: { mode: 'weight', target: 22 },
        '소비재/클라우드': { mode: 'weight', target: 16 },
        자동차: { mode: 'weight', target: 17 },
        IT서비스: { mode: 'weight', target: 15 },
      },
    },
    ticker: {
      enabled: true, tolerance: 4,
      items: {
        '005930.KS': { mode: 'shares', target: 100, note: '100주 채우기' },
        '066570.KS': { mode: 'amount', target: 3000000, note: '300만원어치 보유' },
        AAPL: { mode: 'weight', target: 22 },
        AMZN: { mode: 'weight', target: 16 },
        TSLA: { mode: 'weight', target: 17 },
        'FPT.VN': { mode: 'weight', target: 15 },
      },
    },
  };
  db.rules = {
    cash: 0,
    max_position_weight: 30,
    min_position_weight: 3,
    take_profit_pct: 60,
    stop_loss_pct: -25,
    min_trade_amount: 300000,
  };
  db.bypass = {
    enabled: true,
    entries: [
      { scope: 'ticker', key: 'TSLA', reason: '장기 보유라 비중 넘어도 안 판다', until: '2026-12-31' },
      { scope: 'sector', key: 'IT서비스', reason: '베트남 환전이 번거로워 당분간 보류', until: '' },
    ],
  };
  db.quotes = {
    '005930.KS': { price: 78500, previousClose: 77900, currency: 'KRW', source: '예시값', asOf: '2026-08-22T15:30:00+09:00', stale: true },
    '066570.KS': { price: 94300, previousClose: 95100, currency: 'KRW', source: '예시값', asOf: '2026-08-22T15:30:00+09:00', stale: true },
    AAPL: { price: 232.5, previousClose: 229.8, currency: 'USD', source: '예시값', asOf: '2026-08-21T16:00:00-04:00', stale: true },
    AMZN: { price: 214.3, previousClose: 216.1, currency: 'USD', source: '예시값', asOf: '2026-08-21T16:00:00-04:00', stale: true },
    TSLA: { price: 341.2, previousClose: 333.9, currency: 'USD', source: '예시값', asOf: '2026-08-21T16:00:00-04:00', stale: true },
    'FPT.VN': { price: 118500, previousClose: 117000, currency: 'VND', source: '예시값', asOf: '2026-08-22T15:00:00+07:00', stale: true },
  };
  db.fx = {
    base: 'KRW',
    rates: { KRW: 1, USD: 1340, VND: 0.0525 },
    sources: { KRW: 'base', USD: '예시값', VND: '예시값' },
    asOf: '2026-08-22T16:00:00+09:00',
  };
  return db;
}

// ---------------------------------------------------------------- IndexedDB 미러
function idb() {
  return new Promise((resolve) => {
    if (!('indexedDB' in globalThis)) return resolve(null);
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { return resolve(null); }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function idbPut(value) {
  const db = await idb();
  if (!db) return;
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(value, KEY);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch { /* 미러 실패는 치명적이지 않다 */ }
  db.close();
}

async function idbGet() {
  const db = await idb();
  if (!db) return null;
  try {
    const value = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value;
  } catch { db.close(); return null; }
}

// ---------------------------------------------------------------- 저장소 본체
export class Store {
  constructor() {
    this.db = emptyDB();
    this.listeners = new Set();
    this.persisted = null; // navigator.storage.persist() 결과
    this.lastError = null;
    this.sync = this.loadSyncConfig();
  }

  // ---- 동기화 설정 (기기에만 남고 절대 업로드되지 않는다) ----
  loadSyncConfig() {
    try {
      return JSON.parse(localStorage.getItem(SYNC_KEY) || '{}');
    } catch { return {}; }
  }

  saveSyncConfig(patch) {
    this.sync = { ...this.sync, ...patch };
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(this.sync)); } catch { /* 무시 */ }
    return this.sync;
  }

  clearSyncConfig() {
    this.sync = {};
    try { localStorage.removeItem(SYNC_KEY); } catch { /* 무시 */ }
  }

  get syncEnabled() {
    return Boolean(this.sync?.token && this.sync?.gistId);
  }

  // 업로드할 알맹이. 토큰 같은 기기 전용 값은 들어가지 않는다.
  payload() {
    const { apiKeys, ...rest } = this.db;
    return rest;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this.db)); }

  async init() {
    // 브라우저가 용량 정리하면서 지우지 않도록 요청 (사용자 승인 없이 되는 경우가 많다)
    try {
      if (navigator.storage?.persist) {
        this.persisted = await navigator.storage.persisted?.() || false;
        if (!this.persisted) this.persisted = await navigator.storage.persist();
      }
    } catch { this.persisted = null; }

    let loaded = null;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch (e) { this.lastError = e; }

    // localStorage 가 비었으면 IndexedDB 미러에서 복구
    if (!loaded) {
      const mirror = await idbGet();
      if (mirror) {
        loaded = mirror;
        this.recoveredFromMirror = true;
      }
    }

    this.db = loaded ? migrate(loaded) : sampleDB();
    this.isFirstRun = !loaded;
    if (this.isFirstRun) await this.save({ snapshot: false });
    return this.db;
  }

  async save({ snapshot = true } = {}) {
    if (snapshot) this.pushSnapshot();
    this.db.updatedAt = new Date().toISOString();
    const json = JSON.stringify(this.db);
    try {
      localStorage.setItem(KEY, json);
      this.lastError = null;
    } catch (e) {
      this.lastError = e; // 용량 초과 등
    }
    idbPut(this.db); // 비동기 미러 (await 안 해도 됨)
    this.emit();
    return this.lastError;
  }

  // ---- 스냅샷(되돌리기) ----
  pushSnapshot() {
    try {
      const prev = localStorage.getItem(KEY);
      if (!prev) return;
      const snaps = this.snapshots();
      snaps.unshift({ at: new Date().toISOString(), data: prev });
      localStorage.setItem(SNAP_KEY, JSON.stringify(snaps.slice(0, MAX_SNAPSHOTS)));
    } catch { /* 스냅샷 실패는 무시 */ }
  }

  snapshots() {
    try { return JSON.parse(localStorage.getItem(SNAP_KEY) || '[]'); } catch { return []; }
  }

  async restoreSnapshot(index = 0) {
    const snap = this.snapshots()[index];
    if (!snap) return false;
    this.db = migrate(JSON.parse(snap.data));
    await this.save({ snapshot: false });
    return true;
  }

  // ---- 거래 ----
  addTransaction(tx) {
    const row = { ...tx, id: tx.id || uid() };
    this.db.transactions.push(row);
    this.sortTransactions();
    return row;
  }

  updateTransaction(id, patch) {
    const i = this.db.transactions.findIndex((t) => t.id === id);
    if (i < 0) return null;
    // 수정 시각을 남겨야 다른 기기의 삭제 기록과 충돌할 때 판단할 수 있다
    this.db.transactions[i] = {
      ...this.db.transactions[i], ...patch, id, updatedAt: new Date().toISOString(),
    };
    this.sortTransactions();
    return this.db.transactions[i];
  }

  deleteTransaction(id) {
    const before = this.db.transactions.length;
    this.db.transactions = this.db.transactions.filter((t) => t.id !== id);
    const removed = this.db.transactions.length < before;
    if (removed) {
      this.db.deletedIds = [
        ...(this.db.deletedIds || []).filter((t) => t.id !== id),
        { id, at: new Date().toISOString() },
      ].slice(-200);
    }
    return removed;
  }

  sortTransactions() {
    this.db.transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // ---- 종목 마스터 ----
  upsertAsset(ticker, meta) {
    this.db.assets[ticker] = { ...(this.db.assets[ticker] || {}), ...meta };
  }

  deleteAsset(ticker) {
    delete this.db.assets[ticker];
    Object.values(this.db.targets || {}).forEach((g) => { delete g.items?.[ticker]; });
    delete this.db.quotes[ticker];
  }

  setQuote(ticker, quote) {
    this.db.quotes[ticker] = { ...(this.db.quotes[ticker] || {}), ...quote };
  }

  // ---- 백업 ----
  exportJSON() {
    return JSON.stringify({ ...this.db, exportedAt: new Date().toISOString() }, null, 2);
  }

  exportCSV() {
    const head = 'date,ticker,side,quantity,price,fee,account,note,id';
    const rows = this.db.transactions.map((t) => [
      t.date, t.ticker, t.side, t.quantity, t.price, t.fee ?? 0,
      t.account ?? '', (t.note ?? '').replace(/[",\n]/g, ' '), t.id,
    ].join(','));
    return [head, ...rows].join('\n');
  }

  async importJSON(text, { merge = false } = {}) {
    const incoming = migrate(JSON.parse(text));
    if (!merge) {
      this.db = incoming;
    } else {
      const seen = new Set(this.db.transactions.map(naturalKey));
      const added = (incoming.transactions || []).filter((t) => !seen.has(naturalKey(t)));
      this.db.transactions.push(...added);
      this.sortTransactions();
      this.db.assets = { ...incoming.assets, ...this.db.assets };
      this.db.quotes = { ...this.db.quotes, ...incoming.quotes };
    }
    await this.save();
    return this.db.transactions.length;
  }

  // 폰/엑셀에서 뽑은 CSV 붙여넣기용. 한글 헤더도 받는다.
  async importCSV(text, { merge = true } = {}) {
    const rows = parseCSV(text);
    if (!rows.length) throw new Error('읽을 수 있는 행이 없습니다');
    const seen = new Set(this.db.transactions.map(naturalKey));
    let added = 0;
    for (const row of rows) {
      const tx = rowToTx(row);
      if (!tx) continue;
      if (merge && seen.has(naturalKey(tx))) continue;
      seen.add(naturalKey(tx));
      this.db.transactions.push(tx);
      added += 1;
      if (!this.db.assets[tx.ticker]) {
        this.db.assets[tx.ticker] = guessAsset(tx.ticker);
      }
    }
    this.sortTransactions();
    await this.save();
    return added;
  }

  async resetToSample() {
    this.db = sampleDB();
    await this.save();
  }

  async clearAll() {
    this.db = emptyDB();
    await this.save();
  }

  async storageInfo() {
    let usage = null; let quota = null;
    try {
      const est = await navigator.storage?.estimate?.();
      usage = est?.usage ?? null; quota = est?.quota ?? null;
    } catch { /* 지원 안 하는 브라우저 */ }
    return { usage, quota, persisted: this.persisted, error: this.lastError };
  }
}

// ---------------------------------------------------------------- 헬퍼
export function naturalKey(t) {
  return [t.date, t.ticker, t.side, Number(t.quantity), Number(t.price), t.account || ''].join('|');
}

function migrate(db) {
  const base = emptyDB();
  const out = { ...base, ...db };
  out.rules = { ...base.rules, ...(db.rules || {}) };
  out.bypass = { ...base.bypass, ...(db.bypass || {}) };
  out.fx = { ...base.fx, ...(db.fx || {}) };
  out.assets = db.assets || {};
  out.quotes = db.quotes || {};
  out.targets = db.targets || {};
  out.deletedIds = db.deletedIds || [];
  out.transactions = (db.transactions || []).map((t) => ({
    ...t,
    id: t.id || uid(),
    date: (t.date || today()).slice(0, 10),
    side: String(t.side || 'BUY').toUpperCase(),
    quantity: Math.abs(Number(t.quantity) || 0),
    price: Number(t.price) || 0,
    fee: Number(t.fee) || 0,
    account: t.account || '기본',
  }));
  // 예전 형식(mode 없음) 보정
  Object.values(out.targets).forEach((g) => {
    Object.values(g.items || {}).forEach((it) => { it.mode = it.mode || 'weight'; });
  });
  out.version = SCHEMA_VERSION;
  return out;
}

const HEADER_ALIASES = {
  date: ['date', '날짜', '거래일', '매매일자', '체결일', '일자'],
  ticker: ['ticker', 'symbol', '종목', '종목코드', '티커', 'code', '종목명'],
  side: ['side', 'type', '구분', '매매구분', '거래구분', '매매'],
  quantity: ['quantity', 'qty', 'shares', '수량', '주수', '주식수', '체결수량'],
  price: ['price', '단가', '가격', '매입가', '체결단가', '평단'],
  fee: ['fee', 'commission', '수수료', '제비용', '세금'],
  account: ['account', '계좌', '증권사', 'broker', '계좌명'],
  note: ['note', 'memo', '메모', '비고'],
  id: ['id', 'txid', 'uid'],
};

const normHeader = (s) => String(s || '').replace(/[\s_\-/().]/g, '').toLowerCase();

export function parseCSV(text) {
  const clean = text.replace(/^﻿/, '').trim();
  if (!clean) return [];
  const delim = (clean.split('\n')[0].match(/\t/g) || []).length
    > (clean.split('\n')[0].match(/,/g) || []).length ? '\t' : ',';
  const lines = clean.split(/\r?\n/).filter((l) => l.trim());
  const header = splitLine(lines[0], delim).map(normHeader);
  const map = {};
  Object.entries(HEADER_ALIASES).forEach(([field, names]) => {
    const idx = header.findIndex((h) => names.map(normHeader).includes(h));
    if (idx >= 0) map[field] = idx;
  });
  if (map.ticker === undefined || map.quantity === undefined) {
    throw new Error('종목/수량 컬럼을 찾지 못했습니다');
  }
  return lines.slice(1).map((line) => {
    const cells = splitLine(line, delim);
    const row = {};
    Object.entries(map).forEach(([field, idx]) => { row[field] = cells[idx]; });
    return row;
  });
}

function splitLine(line, delim) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = !quoted;
    } else if (ch === delim && !quoted) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

const BUY_WORDS = ['buy', 'b', '매수', '구매', '매입', '+'];
const SELL_WORDS = ['sell', 's', '매도', '판매', '-'];

function rowToTx(row) {
  const ticker = String(row.ticker || '').trim();
  const qty = toNumber(row.quantity);
  if (!ticker || !qty) return null;
  const sideRaw = normHeader(row.side || 'buy');
  const side = SELL_WORDS.includes(sideRaw) ? 'SELL'
    : (BUY_WORDS.includes(sideRaw) || !sideRaw) ? 'BUY' : null;
  if (!side) return null;
  return {
    id: row.id || uid(),
    date: parseDate(row.date),
    ticker,
    side,
    quantity: Math.abs(qty),
    price: toNumber(row.price),
    fee: toNumber(row.fee),
    account: String(row.account || '기본').trim() || '기본',
    note: String(row.note || '').trim(),
  };
}

function toNumber(v) {
  const s = String(v ?? '').replace(/[,\s₩$원]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseDate(v) {
  const s = String(v || '').trim().split(/[ T]/)[0];
  if (!s) return today();
  const m = s.match(/^(\d{4})[-./]?(\d{1,2})[-./]?(\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? today() : d.toISOString().slice(0, 10);
}

// 티커 접미사로 국가/통화 추측 (005930.KS -> 한국/원)
export function guessAsset(ticker) {
  const t = String(ticker).toUpperCase();
  if (/\.(KS|KQ)$/.test(t)) return { name: ticker, country: 'KR', currency: 'KRW', sector: '기타', asset_class: '주식', tags: [] };
  if (/\.VN$/.test(t)) return { name: ticker, country: 'VN', currency: 'VND', sector: '기타', asset_class: '주식', tags: [] };
  if (/\.T$/.test(t)) return { name: ticker, country: 'JP', currency: 'JPY', sector: '기타', asset_class: '주식', tags: [] };
  if (/\.(HK)$/.test(t)) return { name: ticker, country: 'HK', currency: 'HKD', sector: '기타', asset_class: '주식', tags: [] };
  if (/^\d{6}$/.test(t)) return { name: ticker, country: 'KR', currency: 'KRW', sector: '기타', asset_class: '주식', tags: [] };
  return { name: ticker, country: 'US', currency: 'USD', sector: '기타', asset_class: '주식', tags: [] };
}
