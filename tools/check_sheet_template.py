# -*- coding: utf-8 -*-
import sys, warnings; warnings.filterwarnings('ignore')
import formulas
f = sys.argv[1]
sol = formulas.ExcelModel().loads(f).finish().calculate()
def g(sh, ref):
    v = sol.get(f"'[{f}]{sh}'!{ref}")
    if v is None: return None
    try: return v.value[0, 0]
    except Exception: return v
def n(x):
    try: return float(x)
    except Exception: return 0.0

errs = []
for k, v in sol.items():
    if "'!" not in k: continue          # 라이브러리 내부 노드는 칸이 아니다
    try: val = v.value[0, 0]
    except Exception: continue
    s = str(val)
    if s.startswith('#') and s not in ('#EMPTY', '#N/A'):
        errs.append((k.split(']')[-1], s))
print(f'수식 오류: {len(errs)}건')
for k, e in errs[:15]: print('  ', k, e)

print(f"\n투자 합계(계좌) {n(g('자산배분','I2')):>14,.0f}")
print(f"종목 합계        {n(g('자산배분','Q32')):>14,.0f}")
print(f"검산            {g('자산배분','I3')}")
print(f"목표비율 합계 {n(g('자산배분','U2'))*100:.0f}%   현재비율 합계 {n(g('자산배분','U3'))*100:.0f}%"
      f"   {g('자산배분','V2') or ''}")
print('\n자산군      ' + '  '.join(f"{g('자산배분',f'{c}1'):>6}" for c in 'LMNOPQRST'))
print('목표        ' + '  '.join(f"{n(g('자산배분',f'{c}2'))*100:>5.0f}%" for c in 'LMNOPQRST'))
print('현재        ' + '  '.join(f"{n(g('자산배분',f'{c}3'))*100:>5.1f}%" for c in 'LMNOPQRST'))

print(f"\n{'종목':<26}{'현재가':>10}{'매입가':>10}{'수량':>9}{'평가금액':>13}"
      f"{'현재':>7}{'목표':>7}{'매매금액':>13}{'매매량':>10}")
for r in range(6, 31):
    nm = g('자산배분', f'I{r}')
    if not nm or str(nm).startswith('#'): continue
    if n(g('자산배분', f'P{r}')) == 0 and n(g('자산배분', f'Q{r}')) == 0: continue
    print(f"{str(nm):<26}{n(g('자산배분',f'K{r}')):>10,.0f}{n(g('자산배분',f'L{r}')):>10,.0f}"
          f"{n(g('자산배분',f'P{r}')):>9,.2f}{n(g('자산배분',f'Q{r}')):>13,.0f}"
          f"{n(g('자산배분',f'R{r}'))*100:>6.1f}%{n(g('자산배분',f'S{r}'))*100:>6.1f}%"
          f"{n(g('자산배분',f'U{r}')):>+13,.0f}{n(g('자산배분',f'V{r}')):>+10,.2f}")
print('\n계좌별 계')
for a, z in [(2,8),(9,15),(16,22),(23,29),(30,36),(37,43),(44,50),(51,51),(52,53),(54,54)]:
    print(f"  {str(g('자산배분',f'A{a}')):<14}{n(g('자산배분',f'G{a}')):>14,.0f}")
sys.exit(1 if errs else 0)
