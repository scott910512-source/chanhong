// 웹앱 계산 엔진 테스트 (파이썬 엔진과 같은 값이 나와야 한다)
//   node --test tests/js/
import test from 'node:test';
import assert from 'node:assert/strict';

import { sampleDB, emptyDB, parseCSV, guessAsset, naturalKey } from '../../web/js/store.js';
import { buildPortfolio, buildPositions } from '../../web/js/engine.js';
import { BypassRegistry, consolidate, evaluate, bandOf } from '../../web/js/rules.js';

function db(overrides = {}) {
  const base = emptyDB();
  base.targets = {};   // 기본으로 깔리는 국가 목표는 이 테스트들에서 방해가 된다
  base.assets = {
    AAPL: { name: '애플', country: 'US', currency: 'USD', sector: 'IT' },
    '005930.KS': { name: '삼성전자', country: 'KR', currency: 'KRW', sector: '반도체' },
  };
  base.fx = { base: 'KRW', rates: { KRW: 1, USD: 1300 }, sources: {}, asOf: null };
  base.quotes = {
    AAPL: { price: 150, previousClose: 140, currency: 'USD' },
    '005930.KS': { price: 80000, previousClose: 79000, currency: 'KRW' },
  };
  base.transactions = [
    { id: 't1', date: '2024-01-01', ticker: 'AAPL', side: 'BUY', quantity: 10, price: 100, fee: 0, account: '기본' },
    { id: 't2', date: '2024-01-01', ticker: '005930.KS', side: 'BUY', quantity: 10, price: 70000, fee: 0, account: '기본' },
  ];
  return { ...base, ...overrides };
}

test('평단에 매수 수수료가 포함된다', () => {
  const d = db();
  d.transactions = [
    { id: 'a', date: '2024-01-01', ticker: 'AAPL', side: 'BUY', quantity: 10, price: 100, fee: 10 },
    { id: 'b', date: '2024-02-01', ticker: 'AAPL', side: 'BUY', quantity: 10, price: 200, fee: 10 },
  ];
  const { positions } = buildPositions(d);
  assert.equal(positions[0].quantity, 20);
  assert.equal(positions[0].costBasisLocal, 3020);
});

test('매도해도 평단은 유지되고 실현손익이 분리된다', () => {
  const d = db();
  d.transactions = [
    { id: 'a', date: '2024-01-01', ticker: 'AAPL', side: 'BUY', quantity: 10, price: 100, fee: 0 },
    { id: 'b', date: '2024-03-01', ticker: 'AAPL', side: 'SELL', quantity: 4, price: 150, fee: 1 },
  ];
  const pf = buildPortfolio(d);
  const p = pf.positions.find((x) => x.ticker === 'AAPL');
  assert.equal(p.quantity, 6);
  assert.equal(p.avgPriceLocal, 100);
  assert.equal(Math.round(p.realizedPlLocal), 199);
});

test('보유보다 많이 팔면 오류로 잡아준다', () => {
  const d = db();
  d.transactions = [
    { id: 'a', date: '2024-01-01', ticker: 'AAPL', side: 'BUY', quantity: 5, price: 100, fee: 0 },
    { id: 'b', date: '2024-03-01', ticker: 'AAPL', side: 'SELL', quantity: 6, price: 120, fee: 0 },
  ];
  assert.equal(buildPortfolio(d).errors.length, 1);
});

test('환산과 비중 계산', () => {
  const pf = buildPortfolio(db());
  assert.equal(pf.totalValue, 2_750_000);          // 1,950,000 + 800,000
  assert.equal(pf.dayPl, 140_000);
  const aapl = pf.positions.find((p) => p.ticker === 'AAPL');
  assert.equal(aapl.marketValueBase, 1_950_000);
  assert.equal(Math.round(aapl.returnPct), 50);
  assert.equal(Math.round(pf.positions.reduce((s, p) => s + p.weight, 0)), 100);
});

test('예수금이 비중 분모에 들어간다', () => {
  const d = db();
  d.rules.cash = 250_000;
  const pf = buildPortfolio(d);
  assert.equal(pf.totalValue, 3_000_000);
});

test('시세가 없으면 비중에서 빠지고 목록에 남는다', () => {
  const d = db();
  delete d.quotes['005930.KS'];
  const pf = buildPortfolio(d);
  assert.deepEqual(pf.missingPrices, ['005930.KS']);
  assert.equal(pf.totalValue, 1_950_000);
});

test('환율이 없으면 미확보 통화로 보고한다', () => {
  const d = db();
  d.fx.rates = { KRW: 1 };
  const pf = buildPortfolio(d);
  assert.deepEqual(pf.missingFx, ['USD']);
});

test('국가별 집계', () => {
  const pf = buildPortfolio(db());
  const byKey = Object.fromEntries(pf.breakdowns.country.map((b) => [b.key, b]));
  assert.equal(byKey.US.marketValue, 1_950_000);
  assert.equal(byKey.KR.marketValue, 800_000);
});

test('예시 데이터는 파이썬 엔진과 같은 값이 나온다', () => {
  const pf = buildPortfolio(sampleDB());
  assert.equal(Math.round(pf.totalValue), 28_116_719);
  assert.equal(Math.round(pf.unrealizedPl), 8_170_038);
  assert.equal(Math.round(pf.realizedPl), 753_629);
});

// ─────────────────────────── 목표 3가지 모드
test('비중 목표: 초과하면 매도, 미달하면 매수', () => {
  const d = db();
  d.targets = { country: { enabled: true, tolerance: 5, items: {
    US: { mode: 'weight', target: 50 }, KR: { mode: 'weight', target: 50 },
  } } };
  const pf = buildPortfolio(d);
  const { signals } = evaluate(pf, d);
  assert.equal(signals.find((s) => s.key === 'US').action, 'SELL');
  assert.equal(signals.find((s) => s.key === 'KR').action, 'BUY');
});

test('투자금액 목표: 부족한 금액만큼 매수', () => {
  const d = db();
  d.targets = { ticker: { enabled: true, tolerance: 0, items: {
    '005930.KS': { mode: 'amount', target: 1_000_000 },
  } } };
  const pf = buildPortfolio(d);
  const sig = evaluate(pf, d).signals.find((s) => s.key === '005930.KS');
  assert.equal(sig.action, 'BUY');
  assert.equal(Math.round(sig.amountBase), 200_000);   // 800,000 -> 1,000,000
  assert.equal(Math.round(sig.shares), 3);             // 200,000 / 80,000
});

test('주 수량 목표: 모자란 주수만큼 매수', () => {
  const d = db();
  d.targets = { ticker: { enabled: true, tolerance: 0, items: {
    '005930.KS': { mode: 'shares', target: 25 },
  } } };
  const pf = buildPortfolio(d);
  const sig = evaluate(pf, d).signals.find((s) => s.key === '005930.KS');
  assert.equal(sig.action, 'BUY');
  assert.equal(Math.round(sig.shares), 15);            // 10주 보유 -> 25주
  assert.equal(Math.round(sig.amountBase), 1_200_000);
});

test('주 수량 목표 초과 시 보유 주수보다 많이 팔라고 하지 않는다', () => {
  const d = db();
  d.targets = { ticker: { enabled: true, tolerance: 0, items: {
    AAPL: { mode: 'shares', target: 0 },
  } } };
  const pf = buildPortfolio(d);
  const sig = evaluate(pf, d).signals.find((s) => s.key === 'AAPL');
  assert.equal(sig.action, 'SELL');
  assert.ok(sig.shares <= 10);
});

test('항목별 허용오차가 그룹 기본값을 이긴다', () => {
  const item = { mode: 'weight', target: 70, tolerance: 0.5 };
  const { lo, hi } = bandOf(item, 5);
  assert.equal(lo, 69.5);
  assert.equal(hi, 70.5);
});

test('금액/주수 모드의 허용오차는 목표의 %로 계산된다', () => {
  const { lo, hi } = bandOf({ mode: 'amount', target: 1_000_000, tolerance: 10 }, 5);
  assert.equal(lo, 900_000);
  assert.equal(hi, 1_100_000);
});

// ─────────────────────────── 예외
test('예외 처리하면 실행 대상에서 빠지고 사유가 남는다', () => {
  const d = db();
  d.rules.max_position_weight = 40;
  d.bypass = { enabled: true, entries: [{ scope: 'ticker', key: 'AAPL', reason: '장기보유' }] };
  const pf = buildPortfolio(d);
  const sig = evaluate(pf, d).signals.find((s) => s.dimension === 'rule' && s.key === 'AAPL');
  assert.equal(sig.status, 'BYPASSED');
  assert.match(sig.reason, /장기보유/);
});

test('해제일이 지난 예외는 자동으로 다시 감시한다', () => {
  const d = db();
  d.rules.max_position_weight = 40;
  d.bypass = { enabled: true, entries: [{ scope: 'ticker', key: 'AAPL', reason: '옛날', until: '2020-01-01' }] };
  const pf = buildPortfolio(d);
  const reg = new BypassRegistry(d, { today: '2026-01-01' });
  assert.equal(evaluate(pf, d, reg).signals.find((s) => s.dimension === 'rule').status, 'ACTIVE');
});

test('예외 전체 끄기(전수 점검)', () => {
  const d = db();
  d.rules.max_position_weight = 40;
  d.bypass = { enabled: true, entries: [{ scope: 'all', key: '*', reason: '전부' }] };
  const pf = buildPortfolio(d);
  const reg = new BypassRegistry(d, { disabled: true });
  assert.equal(evaluate(pf, d, reg).signals.find((s) => s.dimension === 'rule').status, 'ACTIVE');
});

test('안 걸린 예외는 점검용으로 보고된다', () => {
  const d = db();
  d.bypass = { enabled: true, entries: [{ scope: 'ticker', key: '오타', reason: '' }] };
  const pf = buildPortfolio(d);
  const reg = new BypassRegistry(d);
  evaluate(pf, d, reg);
  assert.deepEqual(reg.unused.map((e) => e.key), ['오타']);
});

// ─────────────────────────── 주문서
test('같은 종목을 가리키는 규칙은 합산하지 않고 가장 큰 것만 남긴다', () => {
  const d = db();
  d.targets = {
    ticker: { enabled: true, tolerance: 1, items: { AAPL: { mode: 'weight', target: 50 } } },
    sector: { enabled: true, tolerance: 1, items: { IT: { mode: 'weight', target: 50 } } },
  };
  d.rules.max_position_weight = 55;
  const pf = buildPortfolio(d);
  const { signals } = evaluate(pf, d);
  const plan = consolidate(signals, pf);
  const aapl = plan.filter((i) => i.ticker === 'AAPL');
  assert.equal(aapl.length, 1);
  const biggest = Math.max(...signals.filter((s) => s.status === 'ACTIVE'
    && s.candidateTickers[0] === 'AAPL').map((s) => s.amountBase));
  assert.equal(Math.round(aapl[0].amountBase), Math.round(biggest));
  assert.ok(aapl[0].reasons.length >= 2);
});

test('매수·매도가 동시에 걸리면 상계한다', () => {
  const d = db();
  d.targets = {
    ticker: { enabled: true, tolerance: 1, items: { AAPL: { mode: 'weight', target: 60 } } },
    sector: { enabled: true, tolerance: 1, items: { IT: { mode: 'weight', target: 80 } } },
  };
  const pf = buildPortfolio(d);
  const plan = consolidate(evaluate(pf, d).signals, pf);
  assert.equal(plan.find((i) => i.ticker === 'AAPL').netted, true);
});

test('예외 처리된 신호는 주문서에 안 들어간다', () => {
  const d = db();
  d.targets = { country: { enabled: true, tolerance: 1, items: { US: { mode: 'weight', target: 10 } } } };
  d.bypass = { enabled: true, entries: [{ scope: 'all', key: '*', reason: '전면 중지' }] };
  const pf = buildPortfolio(d);
  assert.deepEqual(consolidate(evaluate(pf, d, new BypassRegistry(d)).signals, pf), []);
});

test('최소 매매금액보다 작으면 참고로만 표시', () => {
  const d = db();
  d.rules.min_trade_amount = 10_000_000;
  d.targets = { country: { enabled: true, tolerance: 0.1, items: { US: { mode: 'weight', target: 70 } } } };
  const pf = buildPortfolio(d);
  assert.equal(evaluate(pf, d).signals.find((s) => s.key === 'US').status, 'MUTED');
});

// ─────────────────────────── 입력 파싱
test('한글 헤더 CSV 를 읽는다', () => {
  const rows = parseCSV('날짜,종목코드,매매구분,수량,단가\n2024.03.05,005930.KS,매수,"1,000","70,500"');
  assert.equal(rows[0].ticker, '005930.KS');
  assert.equal(rows[0].quantity, '1,000');
});

test('티커로 국가·통화를 추측한다', () => {
  assert.equal(guessAsset('005930.KS').country, 'KR');
  assert.equal(guessAsset('FPT.VN').currency, 'VND');
  assert.equal(guessAsset('AAPL').currency, 'USD');
});

test('같은 거래를 두 번 넣지 않도록 자연키가 일치한다', () => {
  const a = { date: '2024-01-01', ticker: 'AAPL', side: 'BUY', quantity: 10, price: 100, account: '기본' };
  const b = { ...a, id: 'other' };
  assert.equal(naturalKey(a), naturalKey(b));
});

// ─────────────────────────── 보유가 0인 목표도 경고가 떠야 한다
test('목표만 있고 하나도 없는 국가는 매수 경고가 뜬다', () => {
  const d = db();
  delete d.quotes.AAPL;
  d.transactions = d.transactions.filter((t) => t.ticker === '005930.KS');
  d.targets = { country: { enabled: true, tolerance: 5, items: {
    KR: { mode: 'weight', target: 50 }, US: { mode: 'weight', target: 50 },
  } } };
  const pf = buildPortfolio(d);
  const us = evaluate(pf, d).signals.find((s) => s.key === 'US');
  assert.equal(us.action, 'BUY');
  assert.equal(us.status, 'ACTIVE');
  assert.equal(us.current, 0);
  assert.ok(us.amountBase > 0);
});

test('빈 데이터에도 한국·미국 목표가 기본으로 깔려 있다', () => {
  const base = emptyDB();
  assert.deepEqual(Object.keys(base.targets.country.items).sort(), ['KR', 'US']);
  assert.equal(base.targets.country.items.KR.target, 50);
  assert.equal(base.targets.country.items.US.target, 50);
});

test('한 종목만 있어도 없는 국가 경고가 살아 있다', () => {
  const d = emptyDB();                       // 기본 목표(KR/US)를 그대로 쓴다
  d.assets = { '005930.KS': { name: '삼성전자', country: 'KR', currency: 'KRW', sector: '반도체' } };
  d.transactions = [{ id: 'a', date: '2026-01-01', ticker: '005930.KS', side: 'BUY',
    quantity: 1, price: 70000, fee: 0, account: '기본' }];
  d.quotes = { '005930.KS': { price: 80000, currency: 'KRW' } };
  d.fx = { base: 'KRW', rates: { KRW: 1 }, sources: {}, asOf: null };
  const pf = buildPortfolio(d);
  const { signals } = evaluate(pf, d);
  assert.equal(signals.find((s) => s.key === 'US').action, 'BUY');
  assert.equal(signals.find((s) => s.key === 'KR').action, 'SELL');
});
