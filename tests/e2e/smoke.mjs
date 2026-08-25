// 웹앱 실사용 점검. 실제 브라우저를 띄워 사람이 누르는 순서대로 눌러본다.
//
//   node tests/e2e/smoke.mjs
//
// 플레이라이트와 크로미움이 있어야 돌아간다. 없으면 그냥 건너뛴다(종료코드 0).
// 단위 테스트(tests/js)가 계산을 보고, 이쪽은 화면과 손가락 동선을 본다.

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const PORT = 8791;
const ROOT = new URL('../../', import.meta.url).pathname;

let chromium; let devices;
try {
  const require = createRequire(import.meta.url);
  const pw = require(process.env.PLAYWRIGHT_PATH || 'playwright');
  ({ chromium, devices } = pw);
} catch {
  console.log('· 플레이라이트가 없어 화면 점검을 건너뜁니다');
  process.exit(0);
}

// ── 아주 작은 검사 도구
let pass = 0;
const fails = [];
let group = '';
const g = (name) => { group = name; console.log(`\n── ${name}`); };
function ok(label, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); } else {
    fails.push(`[${group}] ${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}
const eq = (label, got, want) => ok(label, Object.is(got, want), `받음 ${JSON.stringify(got)} / 기대 ${JSON.stringify(want)}`);
const near = (label, got, want, tol) => ok(label, Math.abs(got - want) <= tol, `받음 ${got} / 기대 ${want}±${tol}`);

const srv = spawn('python3', ['-m', 'http.server', String(PORT), '-d', 'web'], { cwd: ROOT, stdio: 'ignore' });
const done = async (code) => { await new Promise((r) => setTimeout(r, 100)); srv.kill(); process.exit(code); };
await new Promise((r) => setTimeout(r, 900));

// 경로를 지정하지 않으면 플레이라이트가 알아서 자기 크로미움을 찾는다.
// 이 개발 상자에는 미리 받아둔 크로미움이 있어서 그때만 짚어준다.
const { existsSync } = await import('node:fs');
const local = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const exe = process.env.CHROMIUM_PATH || (existsSync(local) ? local : undefined);
const browser = await chromium.launch(exe ? { executablePath: exe } : {});
const noise = [];
let answer = '';   // prompt() 에 넣어줄 값 (confirm 은 그냥 확인)
const watch = (p, tag) => {
  p.on('pageerror', (e) => noise.push(`${tag} PAGEERROR ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error') noise.push(`${tag} CONSOLE ${m.text()}`); });
  p.on('dialog', (d) => d.accept(answer));
};

const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
watch(page, '폰');

const txt = async (sel) => (await page.locator(sel).textContent() || '').replace(/\s+/g, ' ').trim();
const wait = (ms) => page.waitForTimeout(ms);
const nums = (s) => (s.match(/-?[\d,]+(\.\d+)?/g) || []).map((v) => Number(v.replace(/,/g, '')));

await page.goto(`http://localhost:${PORT}/index.html`);
await wait(1300);

// ═══════════ 1. 첫 실행
g('첫 실행');
ok('웰컴 화면이 뜬다', await page.locator('#welcome').isVisible());
ok('로그인/가입/둘러보기 버튼이 다 있다',
  await page.locator('#wcSignIn').isVisible() && await page.locator('#wcSignUp').isVisible()
  && await page.locator('#wcSkip').isVisible());
await page.tap('#wcSkip');
await wait(600);
ok('둘러보기로 넘어가면 웰컴이 사라진다', !(await page.locator('#welcome').isVisible()));
ok('현황 화면이 기본으로 열린다', await page.locator('#screen-home').evaluate((e) => e.classList.contains('on')));

// ═══════════ 2. 계산이 화면에 맞게 나오나
g('계산 표시');
const heroTxt = await txt('#hero');
ok('평가금액이 히어로에 보인다', /[\d,]{5,}/.test(heroTxt), heroTxt.slice(0, 60));
const holdRows = await page.locator('#cardHoldings .hold-r').count();
ok('보유 종목이 목록에 나온다', holdRows > 0, `${holdRows}줄`);

// 화면 비중 합이 100% 근처인가
const sumPct = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#cardCountry .alloc-r')];
  return rows.reduce((s, r) => {
    const m = (r.textContent || '').match(/([\d.]+)%/);
    return s + (m ? Number(m[1]) : 0);
  }, 0);
});
ok('국가별 비중 합이 100% 근처', sumPct === 0 || Math.abs(sumPct - 100) < 1.5, `${sumPct.toFixed(1)}%`);

// 엔진 값과 화면 값이 같은가
const engine = await page.evaluate(async () => {
  const { buildPortfolio } = await import('./js/engine.js');
  const raw = JSON.parse(localStorage.getItem('chanhong.portfolio.v1'));
  const pf = buildPortfolio(raw);
  return { total: Math.round(pf.totalValue), n: pf.positions.length };
});
const heroNums = nums(heroTxt);
ok('히어로 금액 = 엔진 계산값', heroNums.includes(engine.total)
  || heroNums.some((v) => Math.abs(v - engine.total) <= 1), `화면 ${heroNums[0]} / 엔진 ${engine.total}`);

// ═══════════ 3. 정렬·기준 전환
g('정렬과 기준 전환');
for (const s of ['gain', 'name', 'amount']) {
  await page.tap(`#cardHoldings [data-sort="${s}"]`).catch(() => {});
  await wait(150);
}
ok('정렬 세 가지를 눌러도 목록이 남아 있다',
  await page.locator('#cardHoldings .hold-r').count() > 0);
// 기준을 바꾸면 카드 '전체'가 그 기준으로 바뀌어야 한다.
// 가운데 숫자만 금액으로 남아 있으면 뭘 보고 있는지 알 수가 없다.
const amtCountry = await txt('#cardCountry');
ok('금액 기준: 가운데가 총 자산 금액', amtCountry.includes('총 자산'), amtCountry.slice(0, 55));
ok('금액 기준: 열 제목이 현재 비중', amtCountry.includes('현재 비중'));
ok('금액 기준: 값이 %로 나온다', /\d+\.\d%/.test(amtCountry));

await page.tap('#cardCountry [data-basis="shares"]');
await wait(300);
const qtyCountry = await txt('#cardCountry');
ok('수량 기준: 가운데가 총 보유 주수로 바뀐다',
  qtyCountry.includes('총 보유') && qtyCountry.includes('주') && !qtyCountry.includes('총 자산'),
  qtyCountry.slice(0, 70));
ok('수량 기준: 열 제목이 보유 수량', qtyCountry.includes('보유 수량'), qtyCountry.slice(0, 70));
ok('수량 기준: 합계도 주 수로 나온다', /합계 [\d,]+주/.test(qtyCountry),
  qtyCountry.slice(-40));
const qtySector = await txt('#cardSector');
ok('섹터 카드도 같이 수량 기준으로 바뀐다', qtySector.includes('보유 수량'), qtySector.slice(0, 70));
ok('섹터 막대가 살아 있다',
  await page.evaluate(() => [...document.querySelectorAll('#cardSector .track i')]
    .some((e) => parseFloat(e.style.width) > 0)));

await page.tap('#cardCountry [data-basis="amount"]');
await wait(300);
ok('금액 기준으로 되돌아온다', (await txt('#cardCountry')).includes('총 자산'));

// 목표를 %가 아닌 단위로 걸어도 화면이 안 깨지는지
g('금액·주수 목표 표시');
const shown = await page.evaluate(async () => {
  const ui = await import('./js/ui.js');
  const { buildPortfolio } = await import('./js/engine.js');
  const db = JSON.parse(localStorage.getItem('chanhong.portfolio.v1'));
  db.targets = db.targets || {};
  db.targets.country = { enabled: true, tolerance: 5, items: {
    KR: { mode: 'amount', target: 5000000 },
    US: { mode: 'weight', target: 40 },
  } };
  db.targets.sector = { enabled: true, tolerance: 10, items: {
    반도체: { mode: 'shares', target: 120 },
  } };
  const pf = buildPortfolio(db);
  ui.renderCountryCard(pf, db, 'amount');
  ui.renderSectorCard(pf, db, 'amount');
  const bars = [...document.querySelectorAll('#cardSector .track i')].map((e) => e.style.width);
  return { c: document.querySelector('#cardCountry').textContent.replace(/\s+/g, ' '),
    s: document.querySelector('#cardSector').textContent.replace(/\s+/g, ' '), bars };
});
// 좁은 칸이라 만/억으로 줄여 쓴다. 뜻은 그대로.
ok('투자금액 목표는 금액으로 뜬다 (5000000% 아님)',
  shown.c.includes('500만') && !shown.c.includes('5000000%'), shown.c.slice(0, 110));
ok('비중 목표는 그대로 %로 뜬다', shown.c.includes('40%'));
ok('주수 목표는 주로 뜬다 (120% 아님)',
  shown.s.includes('120주') && !shown.s.includes('120%'), shown.s.slice(0, 110));
ok('금액 목표가 섞여도 섹터 막대가 안 짜부라진다',
  shown.bars.some((w) => parseFloat(w) > 1), shown.bars.join(','));
await page.reload();
await wait(1300);
if (await page.locator('#wcSkip').isVisible().catch(() => false)) { await page.tap('#wcSkip'); await wait(500); }

// ═══════════ 4. 상단 안내
g('상단 안내');
const before = await txt('#topWarn');
ok('기본은 한 줄', (await page.locator('#topWarn .tip').count()) <= 1, before.slice(0, 50));
await page.tap('#topWarn [data-expand]');
await wait(250);
const openN = await page.locator('#topWarn .tip').count();
ok('누르면 펴진다', openN > 1, `${openN}줄`);
ok('펴진 상태에 접기 버튼이 있다', await page.locator('#topWarn [data-collapse]').count() === 1);
await page.tap('#topWarn [data-collapse]');
await wait(250);
eq('다시 한 줄로 접힌다', await page.locator('#topWarn .tip').count(), 1);
const badge = await txt('#alertCount');
await page.tap('#topWarn [data-tips-close]');
await wait(250);
eq('닫으면 안내가 사라진다', await txt('#topWarn'), '');
eq('닫아도 종 배지 숫자는 남는다', await txt('#alertCount'), badge);
await page.tap('#btnAlerts');
await wait(400);
ok('종을 누르면 펼쳐진 채로 돌아온다', await page.locator('#topWarn .tip').count() > 1);

// ═══════════ 5. 종목 추가
g('종목 추가');
await page.tap('#btnAdd');
await wait(350);
ok('내 주식 관리로 넘어간다', await page.locator('#screen-trades').evaluate((e) => e.classList.contains('on')));
const cnt0 = nums(await txt('#txCount'));
await page.tap('#btnAddStock');
await wait(350);
ok('거래 시트가 열린다', !(await page.locator('#sheet').evaluate((e) => e.hidden)));

for (const [q, want] of [['삼성', '삼성전자'], ['ㅅㅅㅈㅈ', '삼성전자'], ['AAPL', '애플'], ['apple', '애플']]) {
  await page.fill('#pickSearch', q);
  await wait(280);
  const res = await txt('#pickResults');
  ok(`검색 "${q}" → ${want}`, res.includes(want), res.slice(0, 60));
}
await page.fill('#pickSearch', '엔비디아');
await wait(300);
await page.locator('#pickResults [data-pick]').first().tap();
await wait(300);
ok('종목을 고르면 입력 폼이 나온다', !(await page.locator('#txForm').evaluate((e) => e.hidden)));
await page.fill('#txForm [name=quantity]', '10');
await page.fill('#txForm [name=price]', '900');
await page.fill('#txForm [name=fee]', '5');
await wait(200);
const prev = await txt('#txPreview');
ok('미리보기에 수수료 포함 금액이 나온다', nums(prev).some((v) => Math.abs(v - 9005) < 1), prev);
await page.tap('#btnSaveTx');
await wait(700);
ok('저장하면 시트가 닫힌다', await page.locator('#sheet').evaluate((e) => e.hidden));
const cnt1 = nums(await txt('#txCount'));
eq('종목 수가 하나 늘었다', cnt1[0], cnt0[0] + 1);
eq('거래 수가 하나 늘었다', cnt1[1], cnt0[1] + 1);

// 평단에 수수료가 반영됐나
const avg = await page.evaluate(async () => {
  const { buildPortfolio } = await import('./js/engine.js');
  const pf = buildPortfolio(JSON.parse(localStorage.getItem('chanhong.portfolio.v1')));
  const p = pf.positions.find((x) => x.ticker === 'NVDA');
  return p ? p.avgPriceLocal : null;
});
near('평단 = (10×900+5)/10 = 900.5', avg, 900.5, 0.01);

// ═══════════ 6. 수정
g('거래 수정');
await page.locator('#manageList [data-stock="NVDA"]').tap();
await wait(300);
await page.locator('#manageList .trade[data-id]').first().tap();
await wait(350);
eq('수정 화면으로 열린다', await txt('#sheetTitle'), '거래 수정');
eq('기존 수량이 채워져 있다', await page.locator('#txForm [name=quantity]').inputValue(), '10');
ok('삭제 버튼이 보인다', !(await page.locator('#btnDeleteTx').evaluate((e) => e.hidden)));
await page.fill('#txForm [name=quantity]', '25');
await page.tap('#btnSaveTx');
await wait(700);
const q2 = await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1'))
  .transactions.filter((t) => t.ticker === 'NVDA').reduce((s, t) => s + t.quantity, 0));
eq('수량이 25로 바뀐다', q2, 25);
eq('거래가 늘지 않는다(수정이지 추가가 아님)', nums(await txt('#txCount'))[1], cnt1[1]);

// ═══════════ 7. 매수·매도 바로가기
g('매수·매도 바로가기');
if (!await page.locator('#manageList [data-buy]').count()) {
  await page.locator('#manageList [data-stock="NVDA"]').tap(); await wait(300);
}
await page.locator('#manageList [data-sell]').first().tap();
await wait(350);
eq('매도 시트가 열린다', await txt('#sheetTitle'), '매도 추가');
eq('매도로 미리 선택돼 있다', await page.locator('#txForm [name=side]').inputValue(), 'SELL');
await page.fill('#txForm [name=quantity]', '5');
await page.fill('#txForm [name=price]', '1000');
await page.tap('#btnSaveTx');
await wait(700);
const after = await page.evaluate(async () => {
  const { buildPortfolio } = await import('./js/engine.js');
  const pf = buildPortfolio(JSON.parse(localStorage.getItem('chanhong.portfolio.v1')));
  const p = pf.positions.find((x) => x.ticker === 'NVDA');
  return p ? { qty: p.quantity, avg: p.avgPriceLocal, realized: p.realizedPlLocal } : null;
});
eq('매도 후 수량 25-5=20', after.qty, 20);
near('매도해도 평단은 그대로', after.avg, 900.2, 0.01);
near('실현손익 = (1000-900.2)×5', after.realized, 499, 0.5);

// ═══════════ 8. 현재가 저장
g('현재가 저장');
answer = '1234';
await page.locator('#manageList [data-price]').first().tap();
await wait(500);
answer = '';
const savedQuote = await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1')).quotes?.NVDA?.price);
ok('현재가 입력이 저장된다', savedQuote !== undefined, String(savedQuote));

// ═══════════ 9. 새로고침해도 남아 있나
g('데이터 보존');
const snapBefore = await page.evaluate(() => localStorage.getItem('chanhong.portfolio.v1').length);
await page.reload();
await wait(1400);
if (await page.locator('#wcSkip').isVisible().catch(() => false)) { await page.tap('#wcSkip'); await wait(500); }
const snapAfter = await page.evaluate(() => localStorage.getItem('chanhong.portfolio.v1').length);
ok('새로고침해도 데이터가 남는다', Math.abs(snapAfter - snapBefore) < 200, `${snapBefore} → ${snapAfter}`);
const stillNvda = await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1'))
  .transactions.some((t) => t.ticker === 'NVDA'));
ok('넣은 거래가 그대로 있다', stillNvda);

// ═══════════ 10. 설정 - 목표 비중
g('설정');
await page.tap('.tabbar button[data-screen=settings]');
await wait(400);
ok('국가 목표 칸이 있다', await page.locator('#setCountry input[data-target-dim]').count() > 0);
ok('섹터 목표 칸이 있다', await page.locator('#setSector input[data-target-dim]').count() > 0);
const kr = page.locator('#setCountry input[data-target-dim]').first();
await kr.fill('90');
await kr.dispatchEvent('change');
await wait(500);
const savedTarget = await page.evaluate(() => {
  const d = JSON.parse(localStorage.getItem('chanhong.portfolio.v1'));
  return JSON.stringify(d.targets?.country || {});
});
ok('목표 %가 저장된다', savedTarget.includes('90'), savedTarget.slice(0, 80));
await page.tap('.tabbar button[data-screen=home]');
await wait(400);
ok('목표를 바꾸면 안내가 다시 계산된다', Number(await txt('#alertCount')) > 0, await txt('#alertCount'));

// ═══════════ 11. 팝업들
g('설정 팝업');
await page.tap('.tabbar button[data-screen=settings]');
await wait(300);
for (const [k, title] of [['sync', '기기 동기화'], ['rules', null], ['bypass', null],
  ['assets', '종목 정보'], ['fx', '환율'], ['data', '데이터 백업·복원']]) {
  const n = await page.locator(`#screen-settings [data-open="${k}"]`).count();
  if (!n) { ok(`${k} 항목이 있다`, false); continue; }
  await page.tap(`#screen-settings [data-open="${k}"]`);
  await wait(300);
  const open = !(await page.locator('#moreSheet').evaluate((e) => e.hidden));
  const t = await txt('#moreTitle');
  ok(`${k} 팝업이 열린다`, open && (!title || t === title), t);
  await page.locator('#moreSheet [data-close-more]').last().tap();
  await wait(300);
}

// ═══════════ 12. 홈에서 바로 동기화
g('홈에서 동기화');
await page.tap('.tabbar button[data-screen=home]');
await wait(300);
await page.tap('#btnLogin');
await wait(400);
ok('홈에서 계정 아이콘 → 팝업이 바로 뜬다', !(await page.locator('#moreSheet').evaluate((e) => e.hidden)));
eq('제목이 기기 동기화', await txt('#moreTitle'), '기기 동기화');
ok('설정 화면으로 튀지 않는다', await page.locator('#screen-home').evaluate((e) => e.classList.contains('on')));
await page.locator('#moreSheet [data-close-more]').last().tap();
await wait(300);
ok('닫으면 홈 그대로', await page.locator('#screen-home').evaluate((e) => e.classList.contains('on')));

// ═══════════ 13. 더블탭 확대 차단
g('더블탭 확대 차단');
const ta = await page.evaluate(() => [
  getComputedStyle(document.body).touchAction,
  getComputedStyle(document.querySelector('#btnAdd')).touchAction,
]);
ok('touch-action:manipulation 이 걸려 있다', ta.every((v) => v === 'manipulation'), ta.join(','));
ok('viewport 가 핀치를 막지 않는다',
  !(await page.evaluate(() => document.querySelector('meta[name=viewport]').content)).includes('user-scalable=no'));
const tap = await page.evaluate(async () => {
  const fire = (t, x, y) => {
    const to = new Touch({ identifier: 1, target: t, clientX: x, clientY: y });
    const ev = new TouchEvent('touchend', { touches: [], changedTouches: [to], bubbles: true, cancelable: true });
    t.dispatchEvent(ev); return ev.defaultPrevented;
  };
  const b = document.querySelector('#btnAdd');
  const o = { first: fire(b, 100, 100), fast: fire(b, 101, 100) };
  await new Promise((r) => setTimeout(r, 400));
  o.slow = fire(b, 101, 100);
  const t1 = new Touch({ identifier: 1, target: b, clientX: 100, clientY: 100 });
  const t2 = new Touch({ identifier: 2, target: b, clientX: 105, clientY: 100 });
  const pin = new TouchEvent('touchend', { touches: [t2], changedTouches: [t1], bubbles: true, cancelable: true });
  b.dispatchEvent(pin); o.pinch = pin.defaultPrevented;
  return o;
});
ok('첫 탭은 막지 않는다', tap.first === false);
ok('빠른 두 번째 탭만 막는다', tap.fast === true);
ok('느린 탭은 막지 않는다', tap.slow === false);
ok('핀치 중에는 손대지 않는다', tap.pinch === false);
const swap = await page.evaluate(async () => {
  // 화면이 다시 그려져서 '같은 자리에 다른 버튼'이 들어온 경우.
  // 진짜 더블탭이 아니므로 두 번째 탭을 씹으면 안 된다.
  const fire = (t, x, y) => {
    const to = new Touch({ identifier: 1, target: t, clientX: x, clientY: y });
    const ev = new TouchEvent('touchend', { touches: [], changedTouches: [to], bubbles: true, cancelable: true });
    t.dispatchEvent(ev); return ev.defaultPrevented;
  };
  const a = document.querySelector('#btnAdd');
  const b = document.querySelector('#btnAlerts');
  fire(a, 200, 100);
  return { other: fire(b, 202, 101), same: fire(b, 203, 101) };
});
ok('같은 자리라도 다른 버튼이면 안 막는다', swap.other === false);
ok('같은 버튼을 연달아 두드리면 막는다', swap.same === true);

// ═══════════ 14. PWA
g('PWA');
const man = await page.evaluate(async () => {
  const href = document.querySelector('link[rel=manifest]')?.href;
  if (!href) return null;
  return (await fetch(href)).json();
});
ok('manifest 가 있다', Boolean(man));
eq('앱 이름이 찬홍팍', man?.name?.includes('찬홍팍') || man?.short_name?.includes('찬홍팍'), true);
ok('아이콘이 등록돼 있다', (man?.icons || []).length > 0, `${(man?.icons || []).length}개`);
const iconOk = await page.evaluate(async (icons) => {
  const rs = await Promise.all(icons.map((i) => fetch(i.src).then((r) => r.ok).catch(() => false)));
  return rs.every(Boolean);
}, man?.icons || []);
ok('아이콘 파일이 실제로 받아진다', iconOk);
const sw = await page.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => Boolean(r)));
ok('서비스워커가 등록된다', sw);

// ═══════════ 15. 엑셀 내려받기 (컴퓨터 화면)
g('엑셀 내려받기');
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
const pc = await ctx2.newPage();
watch(pc, 'PC');
await pc.goto(`http://localhost:${PORT}/index.html`);
await wait(1300);
if (await pc.locator('#wcSkip').isVisible().catch(() => false)) { await pc.click('#wcSkip'); await wait(500); }
await pc.click('.tabbar button[data-screen=settings]');
await wait(300);
const [dl] = await Promise.all([pc.waitForEvent('download', { timeout: 8000 }).catch(() => null), pc.click('#btnExcel')]);
ok('엑셀 파일이 떨어진다', Boolean(dl), dl ? dl.suggestedFilename() : '없음');
if (dl) {
  const path = await dl.path();
  const { readFileSync } = await import('node:fs');
  const buf = readFileSync(path);
  ok('진짜 zip(xlsx) 형식이다', buf[0] === 0x50 && buf[1] === 0x4b, `${buf.length} bytes`);
  ok('시트 3장이 들어 있다', buf.includes(Buffer.from('sheet3.xml')));
}

// ═══════════ 16. 컴퓨터 화면 배치
g('컴퓨터 화면');
await pc.click('.tabbar button[data-screen=home]');
await wait(400);
const boxes = await pc.evaluate(() => {
  const r = (s) => { const e = document.querySelector(s); const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width) }; };
  return { a: r('.col-a'), b: r('.col-b'), hero: r('#hero') };
});
ok('2단으로 나란히 놓인다', Math.abs(boxes.a.y - boxes.b.y) < 40 && boxes.a.x !== boxes.b.x,
  `col-a x${boxes.a.x} y${boxes.a.y} / col-b x${boxes.b.x} y${boxes.b.y}`);
ok('가로 스크롤이 없다', await pc.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

// ═══════════ 17. 종목 삭제
g('종목 삭제');
await page.tap('.tabbar button[data-screen=trades]');
await wait(400);
const cntA = nums(await txt('#txCount'));
await page.locator('#manageList [data-stock="NVDA"]').tap();
await wait(300);
await page.locator('#manageList [data-drop]').first().tap();
await wait(800);
const cntB = nums(await txt('#txCount'));
ok('종목이 목록에서 빠진다', cntB[0] < cntA[0], `${cntA[0]} → ${cntB[0]}`);
ok('그 종목 거래가 다 지워진다',
  !(await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1'))
    .transactions.some((t) => t.ticker === 'NVDA'))));

// ═══════════ 18. 되돌리기
g('되돌리기');
await page.tap('.tabbar button[data-screen=settings]');
await wait(300);
await page.tap('#screen-settings [data-open="data"]');
await wait(350);
ok('되돌리기 버튼이 있다', await page.locator('#btnUndo').count() === 1);
await page.tap('#btnUndo');
await wait(900);
ok('되돌리면 지운 종목이 살아난다',
  await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1'))
    .transactions.some((t) => t.ticker === 'NVDA')));
await page.tap('.tabbar button[data-screen=home]');
await wait(500);
ok('되돌린 뒤 화면도 같이 갱신된다(옛 데이터를 붙들고 있지 않다)',
  (await txt('#cardHoldings')).includes('NVDA'), (await txt('#cardHoldings')).slice(0, 70));

// ═══════════ 19. 이상한 입력
g('이상한 입력');
await page.tap('.tabbar button[data-screen=trades]');
await wait(400);
const txBefore = await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1')).transactions.length);
await page.tap('#btnAddStock');
await wait(350);
await page.tap('#btnSaveTx');            // 종목도 안 고르고 저장
await wait(400);
ok('종목 없이 저장하면 막힌다', !(await page.locator('#sheet').evaluate((e) => e.hidden)));
await page.fill('#pickSearch', '테슬라');
await wait(300);
await page.locator('#pickResults [data-pick]').first().tap();
await wait(300);
const bad = [['0', '100', '수량 0'], ['-5', '100', '음수 수량'], ['10', '-100', '음수 단가'],
  ['10', '', '단가 빈칸'], ['', '100', '수량 빈칸'], ['abc', '100', '숫자 아닌 수량']];
for (const [q, pr, label] of bad) {
  if (await page.locator('#sheet').evaluate((e) => e.hidden)) {   // 앞 회차가 뚫렸으면 다시 연다
    await page.tap('#btnAddStock'); await wait(300);
    await page.fill('#pickSearch', '테슬라'); await wait(300);
    await page.locator('#pickResults [data-pick]').first().tap(); await wait(300);
  }
  await page.fill('#txForm [name=quantity]', q);
  await page.fill('#txForm [name=price]', pr);
  await page.tap('#btnSaveTx');
  await wait(350);
  ok(`${label} 은 저장되지 않는다`, !(await page.locator('#sheet').evaluate((e) => e.hidden)));
}
await page.fill('#txForm [name=quantity]', '0.5');
await page.fill('#txForm [name=price]', '250.75');
await page.tap('#btnSaveTx');
await wait(700);
ok('소수점 주수는 저장된다', await page.locator('#sheet').evaluate((e) => e.hidden));
const txAfter = await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1')).transactions.length);
eq('막힌 것들은 하나도 안 들어갔다', txAfter, txBefore + 1);

// 보유보다 많이 매도
await page.locator('#manageList [data-stock="TSLA"]').tap();
await wait(300);
await page.locator('#manageList [data-sell]').first().tap();
await wait(350);
await page.fill('#txForm [name=quantity]', '99999');
await page.fill('#txForm [name=price]', '250');
await page.tap('#btnSaveTx');
await wait(700);
const neg = await page.evaluate(async () => {
  const { buildPortfolio } = await import('./js/engine.js');
  const pf = buildPortfolio(JSON.parse(localStorage.getItem('chanhong.portfolio.v1')));
  return pf.positions.filter((p) => p.quantity < 0).map((p) => `${p.ticker}:${p.quantity}`);
});
eq('보유보다 많이 팔아도 마이너스 보유가 안 생긴다', neg.length, 0);
ok('앱이 살아 있다', (await txt('#hero')).length > 0);
await page.tap('.tabbar button[data-screen=home]');
await wait(500);
const status = await txt('#statusBar');
ok('보유 초과 매도를 화면에서 알려준다', status.includes('거래 기록 확인'), status.slice(0, 90));

// ═══════════ 20. 백업 · 복원
g('백업과 복원');
await page.tap('.tabbar button[data-screen=settings]');
await wait(300);
await page.tap('#screen-settings [data-open="data"]');
await wait(350);
const [bk] = await Promise.all([page.waitForEvent('download', { timeout: 6000 }).catch(() => null), page.tap('#btnExportJSON')]);
ok('JSON 백업이 받아진다', Boolean(bk), bk ? bk.suggestedFilename() : '없음');
if (bk) {
  const { readFileSync } = await import('node:fs');
  const j = JSON.parse(readFileSync(await bk.path(), 'utf8'));
  ok('백업에 거래가 들어 있다', Array.isArray(j.transactions) && j.transactions.length > 0, `${j.transactions?.length}건`);
  ok('백업에 API 키가 들어가지 않는다', !JSON.stringify(j).includes('"apiKeys"') || !Object.keys(j.apiKeys || {}).length);
}

// ═══════════ 21. 예시 데이터 되돌리기 · 전체 삭제
// 셋 다 스토어가 db 객체를 통째로 갈아끼우는 길이다. 화면이 따라오는지 본다.
g('예시 되돌리기와 전체 삭제');
const openData = async () => {
  if (!(await page.locator('#moreSheet').evaluate((e) => e.hidden))) {
    await page.locator('#moreSheet [data-close-more]').last().tap(); await wait(300);
  }
  await page.tap('.tabbar button[data-screen=settings]'); await wait(300);
  await page.tap('#screen-settings [data-open="data"]'); await wait(350);
};
await openData();
await page.tap('#btnSample');
await wait(900);
await page.tap('.tabbar button[data-screen=home]');
await wait(500);
const sampleTxt = await txt('#cardHoldings');
ok('예시 데이터로 되돌리면 화면이 바로 바뀐다',
  sampleTxt.includes('삼성전자') && !sampleTxt.includes('NVDA'), sampleTxt.slice(0, 60));
ok('예시 데이터에 TSLA 매도 오류가 남아 있지 않다', !(await txt('#statusBar')).includes('거래 기록 확인'));

await openData();
await page.tap('#btnClear');
await wait(1000);
await page.tap('.tabbar button[data-screen=home]');
await wait(500);
ok('전체 삭제하면 화면도 바로 빈다', (await txt('#cardHoldings')).includes('아직 종목이 없습니다'),
  (await txt('#cardHoldings')).slice(0, 60));
eq('전체 삭제 후 저장된 거래도 0건',
  await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1')).transactions.length), 0);
ok('빈 상태에서도 한국·미국 목표는 깔려 있다',
  await page.evaluate(() => {
    const t = JSON.parse(localStorage.getItem('chanhong.portfolio.v1')).targets?.country?.items || {};
    return Boolean(t.KR && t.US);
  }));
await wait(300);
// 아무것도 안 넣은 새 계좌를 붙잡고 잔소리하면 안 된다. 0원일 때는 조용해야 맞다.
eq('완전히 빈 계좌에서는 경고하지 않는다', await page.locator('#alertCount').isVisible(), false);
eq('빈 계좌에서는 상단 안내도 비어 있다', await txt('#topWarn'), '');
ok('빈 상태에서 히어로가 0으로 그려진다', (await txt('#hero')).length > 0);

// 빈 상태에서 바로 종목을 넣어도 되나
await page.tap('#btnAdd');
await wait(350);
await page.tap('#btnAddStock');
await wait(350);
await page.fill('#pickSearch', '삼성전자');
await wait(300);
await page.locator('#pickResults [data-pick]').first().tap();
await wait(300);
await page.fill('#txForm [name=quantity]', '3');
await page.fill('#txForm [name=price]', '70000');
await page.tap('#btnSaveTx');
await wait(800);
eq('빈 상태에서 첫 종목이 들어간다',
  await page.evaluate(() => JSON.parse(localStorage.getItem('chanhong.portfolio.v1')).transactions.length), 1);

// 형님이 콕 집어 말한 것: 삼성만 1주 있고 미국 주식이 없으면 경고가 떠야 한다
await page.tap('.tabbar button[data-screen=home]');
await wait(600);
ok('삼성만 있고 미국이 없으면 경고가 뜬다', Number(await txt('#alertCount')) > 0, await txt('#alertCount'));
await page.tap('#btnAlerts');
await wait(500);
const tips = await txt('#topWarn');
ok('경고에 미국이 지목된다', tips.includes('미국'), tips.slice(0, 90));
ok('나라 이름이 카드와 경고에서 같다',
  !tips.includes('대한민국') && !(await txt('#cardCountry')).includes('대한민국'),
  tips.slice(0, 60));
ok('안 가진 미국도 국가 카드에 0%로 보인다', (await txt('#cardCountry')).includes('미국'),
  (await txt('#cardCountry')).slice(0, 90));
ok('시세를 못 받은 종목은 총 자산에서 사라지지 않는다',
  nums(await txt('#hero')).some((v) => v === 210000), (await txt('#hero')).slice(0, 60));
ok('그 줄은 매입가 기준임을 밝힌다', (await txt('#cardHoldings')).includes('매입가'),
  (await txt('#cardHoldings')).slice(0, 90));
ok('시세 없음을 상태줄이 알린다', (await txt('#statusBar')).includes('시세 없음'), await txt('#statusBar'));

// ═══════════ 22. 좁은 폰에서 글자 잘림
// 320px 짜리 폰에 최악에 가까운 내용(긴 섹터 이름, 백만 단위 주 수,
// 단위가 뒤섞인 목표)을 넣고 잘리는 글자가 있는지 본다.
g('좁은 폰 글자 잘림');
for (const [label, w] of [['320px', 320], ['360px', 360], ['390px', 390]]) {
  const c = await browser.newContext({
    viewport: { width: w, height: 900 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const np = await c.newPage();
  watch(np, `폰${w}`);
  await np.goto(`http://localhost:${PORT}/index.html`);
  await wait(1200);
  if (await np.locator('#wcSkip').isVisible().catch(() => false)) { await np.tap('#wcSkip'); await wait(400); }
  await np.evaluate(() => {
    const d = JSON.parse(localStorage.getItem('chanhong.portfolio.v1'));
    d.assets = { ...d.assets,
      'VIC.VN': { name: '빈그룹', country: 'VN', currency: 'VND', sector: '소비재/클라우드' },
      '005930.KS': { name: '삼성전자', country: 'KR', currency: 'KRW', sector: '반도체' },
      TSLA: { name: '테슬라', country: 'US', currency: 'USD', sector: '자동차' } };
    d.transactions = [
      { id: 'a', date: '2026-01-02', ticker: '005930.KS', side: 'BUY', quantity: 1234, price: 66666, fee: 0, account: '기본' },
      { id: 'b', date: '2026-01-02', ticker: 'VIC.VN', side: 'BUY', quantity: 1234567, price: 41000, fee: 0, account: '기본' },
      { id: 'c', date: '2026-01-02', ticker: 'TSLA', side: 'BUY', quantity: 12.5, price: 250.75, fee: 0, account: '기본' }];
    d.targets = {
      country: { enabled: true, tolerance: 5, items: { KR: { mode: 'weight', target: 33.3 },
        US: { mode: 'amount', target: 123456789 }, VN: { mode: 'shares', target: 1500000 },
        JP: { mode: 'weight', target: 10 } } },
      sector: { enabled: true, tolerance: 5, items: { '소비재/클라우드': { mode: 'amount', target: 5000000 },
        반도체: { mode: 'shares', target: 1200 }, 자동차: { mode: 'weight', target: 12.5 } } } };
    localStorage.setItem('chanhong.portfolio.v1', JSON.stringify(d));
  });
  await np.reload();
  await wait(1300);
  if (await np.locator('#wcSkip').isVisible().catch(() => false)) { await np.tap('#wcSkip'); await wait(400); }

  for (const basis of ['amount', 'shares']) {
    await np.tap(`#cardCountry [data-basis="${basis}"]`);
    await wait(250);
    await np.evaluate(() => document.querySelector('#topWarn [data-expand]')?.click());
    await wait(250);
    const r = await np.evaluate(() => {
      // 가로로 넘쳤거나(한 줄) 세로로 넘쳤으면(여러 줄) 글자가 잘린 것
      const isCut = (e) => e.scrollWidth > e.clientWidth + 1 || e.scrollHeight > e.clientHeight + 1;
      const out = [];
      const add = (where, e) => { if (e && isCut(e)) out.push(`${where} "${(e.textContent || '').trim()}"`); };
      for (const x of document.querySelectorAll('#cardCountry .alloc-r')) add('국가', x.querySelector('.nm span'));
      for (const x of document.querySelectorAll('#cardSector .sbar-r')) add('섹터', x.querySelector('.nm'));
      for (const x of document.querySelectorAll('#cardHoldings .hold-r')) {
        add('보유이름', x.querySelector('.n1')); add('보유코드', x.querySelector('.n2'));
      }
      // 접힌 한 줄 요약(.sum)은 원래 말줄임이 정상이라 뺀다
      for (const x of document.querySelectorAll('#topWarn .tip:not(.sum)')) add('안내', x.querySelector('.tx'));
      return { cuts: out, over: document.documentElement.scrollWidth > window.innerWidth + 1 };
    });
    const b = basis === 'amount' ? '금액' : '수량';
    ok(`${label} ${b} 기준: 잘리는 글자 없음`, r.cuts.length === 0, r.cuts.join(' / '));
    ok(`${label} ${b} 기준: 가로 스크롤 없음`, !r.over);
  }
  await c.close();
}

// ═══════════ 마무리
console.log('\n════════════════════════════════════');
console.log(`통과 ${pass} · 실패 ${fails.length}`);
if (fails.length) { console.log('\n실패 목록:'); fails.forEach((f) => console.log('  ✗ ' + f)); }
const realNoise = noise.filter((n) => !/favicon|manifest.*404/i.test(n));
console.log(`콘솔 오류 ${realNoise.length}건`);
realNoise.slice(0, 12).forEach((n) => console.log('  ! ' + n));

await browser.close();
await done(fails.length || realNoise.length ? 1 : 0);
