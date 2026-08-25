// 공통 유틸 - 포맷, 날짜, 작은 DOM 헬퍼
export const KRW = new Intl.NumberFormat('ko-KR');

export const COUNTRY_NAMES = {
  KR: '한국', US: '미국', VN: '베트남', JP: '일본', CN: '중국',
  HK: '홍콩', TW: '대만', DE: '독일', GB: '영국', IN: '인도',
};

export const DIM_LABELS = {
  country: '국가', ticker: '종목', sector: '섹터', currency: '통화',
  account: '계좌', asset_class: '자산군', tag: '태그', rule: '개별규칙',
};

export const MODE_LABELS = { weight: '비중 %', amount: '투자금액', shares: '주 수량' };

export function num(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return v.toLocaleString('ko-KR', {
    minimumFractionDigits: digits, maximumFractionDigits: digits,
  });
}

export function signed(v, digits = 0) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const s = num(Math.abs(v), digits);
  return (v > 0 ? '+' : v < 0 ? '-' : '') + s;
}

export function pct(v, digits = 1, withSign = false) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  return (withSign && v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}

// 통화별 소수점 (원/동은 소수점 없음, 달러는 2자리)
export function price(v, currency) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  const digits = ['KRW', 'VND', 'JPY'].includes(currency) ? 0 : 2;
  return num(v, digits);
}

export function plClass(v) {
  if (v === null || v === undefined || Math.abs(v) < 1e-9) return '';
  return v > 0 ? 'up' : 'down';
}

export function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function relTime(iso) {
  if (!iso) return '-';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (Number.isNaN(diff)) return '-';
  if (diff < 60) return '방금';
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

export function uid(prefix = 'tx') {
  const rnd = (crypto.randomUUID?.() || Math.random().toString(36).slice(2)).replace(/-/g, '');
  return `${prefix}_${rnd.slice(0, 12)}`;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function el(sel, root = document) { return root.querySelector(sel); }
export function els(sel, root = document) { return [...root.querySelectorAll(sel)]; }

export function toast(message, kind = 'ok') {
  const box = el('#toast');
  if (!box) return;
  box.textContent = message;
  box.className = `toast show ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { box.className = 'toast'; }, 2600);
}

// 숫자 입력에서 "1,000" "$150.25" "70,500원" 같은 것도 받아준다
export function parseNum(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim().replace(/[,\s₩$원]/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function countryLabel(code) {
  return `${COUNTRY_NAMES[code] || code}(${code})`;
}
