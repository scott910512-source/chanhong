# -*- coding: utf-8 -*-
"""엑셀이 내야 할 값을 파이썬으로 따로 계산한다 (앱 엔진과 같은 규칙).
엑셀 수식이 맞는지 대조하는 용도."""
FX = {'KRW': 1, 'USD': 1340, 'VND': 0.0525}
ASSETS = {
    '005930.KS': ('삼성전자', 'KR', 'KRW', '반도체', 85666),
    '373220.KS': ('LG에너지솔루션', 'KR', 'KRW', '2차전지', 372000),
    'AAPL': ('애플', 'US', 'USD', 'IT하드웨어', 232.8),
    'AMZN': ('아마존', 'US', 'USD', '소비재/클라우드', 178.2),
    'TSLA': ('테슬라', 'US', 'USD', '자동차', 250.75),
    'VIC.VN': ('빈그룹', 'VN', 'VND', '지주/부동산', 41000),
}
TRADES = [
    ('2024-03-04', '005930.KS', 'BUY', 50, 72500, 1090),
    ('2024-05-20', 'AAPL', 'BUY', 20, 189.5, 0.95),
    ('2024-06-11', 'AMZN', 'BUY', 10, 183.2, 0.92),
    ('2024-07-02', 'TSLA', 'BUY', 12, 210.4, 1.05),
    ('2024-09-13', '373220.KS', 'BUY', 3, 401000, 1800),
    ('2024-11-08', 'VIC.VN', 'BUY', 500, 43200, 108),
    ('2025-01-15', '005930.KS', 'BUY', 30, 55900, 840),
    ('2025-04-22', 'TSLA', 'SELL', 5, 268.0, 1.34),
]
pos = {}
for _, tk, side, q, p, fee in TRADES:
    s = pos.setdefault(tk, {'q': 0.0, 'c': 0.0, 'r': 0.0})
    if side == 'BUY':
        s['q'] += q; s['c'] += q * p + fee
    else:
        sold = min(q, s['q']); avg = s['c'] / s['q'] if s['q'] else 0
        s['r'] += sold * p - avg * sold - fee
        s['c'] -= avg * sold; s['q'] -= sold

rows, total = [], 0.0
for tk, (name, ctry, cur, sec, price) in ASSETS.items():
    s = pos.get(tk, {'q': 0, 'c': 0, 'r': 0})
    fx = FX[cur]
    cost = s['c'] * fx
    val = s['q'] * price * fx if price else cost
    total += val
    rows.append((tk, name, ctry, sec, s['q'], s['c'] / s['q'] if s['q'] else 0,
                 cost, val, val - cost, s['r'] * fx))

print(f"{'티커':<11}{'수량':>8}{'평단':>12}{'매입(원)':>14}{'평가(원)':>14}{'손익':>13}{'실현':>11}{'비중':>8}")
for tk, name, c, sec, q, avg, cost, val, pl, rz in rows:
    print(f'{tk:<11}{q:>8.2f}{avg:>12.2f}{cost:>14,.0f}{val:>14,.0f}{pl:>13,.0f}{rz:>11,.0f}{val/total*100:>7.1f}%')
tc = sum(r[6] for r in rows)
print(f"\n총매입 {tc:,.0f} · 총평가 {total:,.0f} · 평가손익 {total-tc:,.0f} "
      f"({(total-tc)/tc*100:.1f}%) · 실현 {sum(r[9] for r in rows):,.0f}")
for dim, idx in (('국가', 2), ('섹터', 3)):
    agg = {}
    for r in rows: agg[r[idx]] = agg.get(r[idx], 0) + r[7]
    print(f'\n[{dim}별]  ' + '  '.join(
        f'{k} {v:,.0f} ({v/total*100:.1f}%)' for k, v in sorted(agg.items(), key=lambda x: -x[1])))
