# -*- coding: utf-8 -*-
"""엑셀 수식을 실제로 계산해서 값이 맞는지 확인한다.

  pip install formulas
  python3 tools/check_excel.py 찬홍팍_주식관리.xlsx

수식이 오류 없이 계산되는지(#NAME? 같은 것) 보고, 나온 값을 찍어준다.
찍힌 값은 tools/expected_excel.py 가 파이썬으로 따로 계산한 값과 같아야 한다.
"""
import sys, warnings
warnings.filterwarnings('ignore')
import formulas

xl = formulas.ExcelModel().loads(sys.argv[1]).finish()
sol = xl.calculate()

BOOK = sys.argv[1].split('/')[-1]
def cell(sheet, ref):
    v = sol.get(f"'[{BOOK}]{sheet}'!{ref}")
    if v is None: return '(못 찾음)'
    try: return v.value[0, 0]
    except Exception: return v

errs = []
for k, v in sol.items():
    try: val = v.value[0, 0]
    except Exception: continue
    s = str(val)
    if s.startswith('#') and s not in ('#EMPTY', '#N/A'):
        errs.append((k.split('!')[-1], k.split(']')[-1].split('!')[0], s))
print(f'수식 오류: {len(errs)}건')
for ref, sh, e in errs[:20]: print('  ', sh, ref, e)
print()

print('── 보유현황')
print(f"{'티커':<12}{'수량':>8}{'평단':>12}{'매입':>13}{'평가':>13}{'손익':>12}{'실현':>11}{'비중':>8}")
for r in range(6, 12):
    tk = cell('보유현황', f'A{r}')
    if not tk or str(tk).startswith('#'): continue
    g = lambda c: cell('보유현황', f'{c}{r}')
    def n(x):
        try: return float(x)
        except Exception: return 0.0
    print(f'{tk:<12}{n(g("F")):>8.2f}{n(g("G")):>12.2f}{n(g("J")):>13,.0f}'
          f'{n(g("K")):>13,.0f}{n(g("L")):>12,.0f}{n(g("O")):>11,.0f}{n(g("N"))*100:>7.1f}%')
print(f"\n총매입 {float(cell('보유현황','B3')):,.0f} · 총평가 {float(cell('보유현황','D3')):,.0f} "
      f"· 평가손익 {float(cell('보유현황','F3')):,.0f} ({float(cell('보유현황','H3'))*100:.1f}%) "
      f"· 실현 {float(cell('보유현황','J3')):,.0f}")

for sh in ('국가별', '섹터별'):
    print(f'\n── {sh}')
    for r in range(4, 10):
        k = cell(sh, f'A{r}')
        if not k or str(k).startswith('#'): continue
        def n(c):
            try: return float(cell(sh, f'{c}{r}'))
            except Exception: return 0.0
        tgt = cell(sh, f'D{r}')
        ts = f'{float(tgt)*100:.0f}%' if isinstance(tgt, (int, float)) else '—'
        print(f'  {str(k):<16} {n("B"):>12,.0f}  현재 {n("C")*100:>5.1f}% / 목표 {ts:>4}  '
              f'{str(cell(sh, f"F{r}")):<8} 조정 {n("G"):>+12,.0f}')
sys.exit(1 if errs else 0)
