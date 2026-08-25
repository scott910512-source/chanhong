// 기기 간 병합 규칙 테스트
import test from 'node:test';
import assert from 'node:assert/strict';
import { merge, makeCode, readCode } from '../../web/js/sync.js';

const tx = (id, date, ticker, extra = {}) =>
  ({ id, date, ticker, side: 'BUY', quantity: 1, price: 100, ...extra });

function base(overrides = {}) {
  return {
    updatedAt: '2026-01-01T00:00:00Z',
    transactions: [], deletedIds: [], assets: {}, quotes: {},
    fx: { rates: {}, asOf: null }, apiKeys: {}, targets: {}, rules: {},
    ...overrides,
  };
}

test('양쪽에서 각각 추가한 거래가 다 남는다', () => {
  const local = base({ transactions: [tx('a', '2026-01-01', 'AAPL')] });
  const remote = base({ transactions: [tx('b', '2026-01-02', 'TSLA')] });
  const m = merge(local, remote);
  assert.deepEqual(m.transactions.map((t) => t.id), ['a', 'b']);
});

test('한쪽에서 지운 거래는 다른 쪽에서 되살아나지 않는다', () => {
  const local = base({
    transactions: [tx('a', '2026-01-01', 'AAPL')],
    deletedIds: [{ id: 'b', at: '2026-02-01T00:00:00Z' }],
  });
  const remote = base({ transactions: [tx('a', '2026-01-01', 'AAPL'), tx('b', '2026-01-02', 'TSLA')] });
  assert.deepEqual(merge(local, remote).transactions.map((t) => t.id), ['a']);
});

test('지운 뒤에 다른 기기에서 고친 거래는 살린다', () => {
  const local = base({ deletedIds: [{ id: 'b', at: '2026-02-01T00:00:00Z' }] });
  const remote = base({
    transactions: [tx('b', '2026-01-02', 'TSLA', { updatedAt: '2026-03-01T00:00:00Z' })],
  });
  assert.deepEqual(merge(local, remote).transactions.map((t) => t.id), ['b']);
});

test('같은 거래는 이 기기 수정본이 남는다', () => {
  const local = base({ transactions: [tx('a', '2026-01-01', 'AAPL', { quantity: 99 })] });
  const remote = base({ transactions: [tx('a', '2026-01-01', 'AAPL', { quantity: 1 })] });
  assert.equal(merge(local, remote).transactions[0].quantity, 99);
});

test('설정은 더 최근에 저장한 쪽을 쓴다', () => {
  const local = base({ updatedAt: '2026-01-01T00:00:00Z', rules: { cash: 1 } });
  const remote = base({ updatedAt: '2026-05-01T00:00:00Z', rules: { cash: 999 } });
  assert.equal(merge(local, remote).rules.cash, 999);
  assert.equal(merge(remote, local).rules.cash, 999);
});

test('API 키는 업로드되지 않으니 병합해도 이 기기 값이 남는다', () => {
  const local = base({ apiKeys: { twelvedata: 'mine' } });
  const remote = base({ updatedAt: '2026-09-01T00:00:00Z' });   // 원격이 더 최신
  assert.deepEqual(merge(local, remote).apiKeys, { twelvedata: 'mine' });
});

test('시세는 종목별로 더 최신 값을 쓴다', () => {
  const local = base({ quotes: { AAPL: { price: 1, asOf: '2026-01-01' }, TSLA: { price: 9, asOf: '2026-09-01' } } });
  const remote = base({ quotes: { AAPL: { price: 2, asOf: '2026-06-01' }, TSLA: { price: 3, asOf: '2026-02-01' } } });
  const m = merge(local, remote);
  assert.equal(m.quotes.AAPL.price, 2);
  assert.equal(m.quotes.TSLA.price, 9);
});

test('원격이 없으면 로컬 그대로', () => {
  const local = base({ transactions: [tx('a', '2026-01-01', 'AAPL')] });
  assert.deepEqual(merge(local, null).transactions.map((t) => t.id), ['a']);
});

test('연결 코드는 왕복해도 그대로다 (한글 포함)', () => {
  const code = makeCode('ghp_토큰테스트123', 'abc123def456');
  const back = readCode(code);
  assert.equal(back.token, 'ghp_토큰테스트123');
  assert.equal(back.gistId, 'abc123def456');
});

test('엉뚱한 연결 코드는 거부한다', () => {
  assert.throws(() => readCode('아무거나'), /연결 코드/);
});
