"""단일 HTML 대시보드 생성기 (외부 라이브러리 0개, 파일 하나로 완결).

그래픽은 나중에 손볼 예정이라 구조/데이터 표시에 집중했다.
data-* 속성과 하단 JSON 블록에 원본 값을 그대로 넣어 두었으니
나중에 차트 라이브러리를 붙일 때 그대로 재사용하면 된다.
"""

from __future__ import annotations

import datetime as dt
import html
import json

from .config import Settings
from .engine import Portfolio
from .models import Signal
from .quotes import QuoteBook
from .rules import dimension_label

ACTION_KO = {"BUY": "매수", "SELL": "매도", "HOLD": "유지"}
STATUS_KO = {"ACTIVE": "실행", "BYPASSED": "예외", "MUTED": "참고", "OK": "적정"}

CSS = """
:root{--bg:#f6f7f9;--card:#fff;--fg:#16181d;--mut:#6b7280;--line:#e4e6eb;
--up:#d92d20;--down:#1570ef;--warn:#b54708;--warnbg:#fffaeb;--ok:#067647;--okbg:#ecfdf3;}
@media (prefers-color-scheme:dark){:root{--bg:#0e1015;--card:#161a22;--fg:#e6e8ee;
--mut:#9aa3b2;--line:#262c38;--warnbg:#2a1f0a;--okbg:#0c2418;}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
font:14px/1.55 -apple-system,BlinkMacSystemFont,"Pretendard","Apple SD Gothic Neo",
"Malgun Gothic",Segoe UI,sans-serif;}
h1{font-size:20px;margin:0 0 4px} h2{font-size:15px;margin:0 0 12px}
.wrap{max-width:1240px;margin:0 auto}
.sub{color:var(--mut);font-size:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;
padding:18px;margin-bottom:16px;overflow-x:auto}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.kpi .k{color:var(--mut);font-size:12px} .kpi .v{font-size:20px;font-weight:650;margin-top:4px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;min-width:640px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{color:var(--mut);font-weight:600;font-size:12px;text-align:right}
th:first-child,td:first-child{text-align:left}
td.l,th.l{text-align:left} td.c,th.c{text-align:center}
.up{color:var(--up)} .down{color:var(--down)} .mut{color:var(--mut)}
.bar{position:relative;height:8px;background:var(--line);border-radius:4px;
min-width:90px;overflow:hidden}
.bar>i{position:absolute;left:0;top:0;bottom:0;background:var(--mut);border-radius:4px}
.bar>u{position:absolute;top:-3px;bottom:-3px;width:2px;background:var(--fg);opacity:.7}
.tag{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;
border:1px solid var(--line)}
.tag.sell{color:var(--up);border-color:var(--up)} .tag.buy{color:var(--ok);border-color:var(--ok)}
.tag.by{color:var(--mut)} .tag.ok{color:var(--ok)}
tr.bypassed{opacity:.55}
.plan{list-style:none;padding:0;margin:0}
.plan li{padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;
background:var(--warnbg)}
.plan li.none{background:var(--okbg)}
.note{background:var(--warnbg);border:1px solid var(--line);border-radius:10px;
padding:10px 12px;color:var(--warn);font-size:12.5px;margin-bottom:16px}
details{margin-top:8px} summary{cursor:pointer;color:var(--mut);font-size:12px}
pre{white-space:pre-wrap;word-break:break-all;font-size:11.5px;color:var(--mut)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(420px,1fr));gap:16px}
"""


def _e(v) -> str:
    return html.escape(str(v))


def _n(v, digits=0, plus=False) -> str:
    if v is None:
        return "-"
    return f"{v:{'+' if plus else ''},.{digits}f}"


def _cls(v) -> str:
    if v is None or abs(v) < 1e-9:
        return ""
    return "up" if v > 0 else "down"


def _pl(v, digits=0) -> str:
    return f'<span class="{_cls(v)}">{_n(v, digits, plus=True)}</span>'


def render(pf: Portfolio, signals: list[Signal], settings: Settings,
           book: QuoteBook) -> str:
    cur = pf.base_currency
    now = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    parts: list[str] = []

    parts.append(f"<h1>내 주식 관리 시스템</h1>")
    src = ", ".join(f"{k} {v}건" for k, v in sorted(book.sources.items())) or "없음"
    fx = " · ".join(
        f"{k}/{cur} {v:,.4g}" for k, v in book.fx.rates.items() if k != cur
    )
    parts.append(f'<div class="sub">기준통화 {cur} · 생성 {now} · 시세출처 {_e(src)}'
                 + (f" · 환율 {_e(fx)}" if fx else "") + "</div>")

    if book.any_stale:
        parts.append('<div class="note">일부 시세가 실시간이 아닌 <b>캐시(스냅샷)</b> 값입니다. '
                     '네트워크가 되는 환경에서 <code>--refresh</code> 로 다시 받아주세요.</div>')
    if pf.missing_prices:
        parts.append(f'<div class="note">시세/환율 미확보: {_e(", ".join(pf.missing_prices))}</div>')

    parts.append(_kpis(pf))
    parts.append(_plan(pf, signals))
    parts.append(_positions(pf))

    dims = [d for d in ("country", "sector", "currency", "asset_class", "account", "tag")
            if pf.breakdown(d)]
    parts.append('<div class="grid2">')
    for d in dims:
        parts.append(_breakdown(pf, d, settings))
    parts.append("</div>")

    parts.append(_signals(pf, signals))
    parts.append(_raw_json(pf, signals, book))

    return (
        "<!doctype html>\n<html lang='ko'>\n<head>\n"
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
        "<title>내 주식 관리 시스템</title>\n"
        f"<style>{CSS}</style>\n</head>\n<body>\n"
        f'<div class="wrap">{"".join(parts)}</div>\n'
        "</body>\n</html>\n"
    )


def _kpis(pf: Portfolio) -> str:
    cur = pf.base_currency
    items = [
        ("총 평가금액", f"{_n(pf.total_value)} {cur}", ""),
        ("매입금액", f"{_n(pf.total_cost)} {cur}", ""),
        ("평가손익", _n(pf.unrealized_pl, plus=True), _cls(pf.unrealized_pl)),
        ("수익률", (f"{pf.return_pct:+.2f}%" if pf.return_pct is not None else "-"),
         _cls(pf.return_pct)),
        ("당일손익", _n(pf.day_pl, plus=True), _cls(pf.day_pl)),
        ("실현손익", _n(pf.realized_pl, plus=True), _cls(pf.realized_pl)),
        ("보유종목", f"{len(pf.positions)}개", ""),
        ("상위3 집중도", f"{pf.top_concentration:.1f}%", ""),
    ]
    cells = "".join(
        f'<div class="kpi"><div class="k">{_e(k)}</div>'
        f'<div class="v {cls}">{v}</div></div>' for k, v, cls in items
    )
    return f'<div class="kpis" style="margin-bottom:16px">{cells}</div>'


def _positions(pf: Portfolio) -> str:
    cur = pf.base_currency
    rows = []
    for p in pf.positions:
        q = p.quote
        day = q.day_change_pct if q else None
        src = (q.source + ("*" if q.stale else "")) if q else "미확보"
        rows.append(
            "<tr>"
            f'<td class="l">{_e(p.asset.name)}<span class="mut"> {_e(p.asset.ticker)}</span></td>'
            f'<td class="c">{_e(p.asset.country)}</td>'
            f'<td class="c">{_e(p.asset.currency)}</td>'
            f"<td>{p.quantity:,.4g}</td>"
            f"<td>{_n(p.avg_price_local, 2)}</td>"
            f"<td>{_n(p.price_local, 2)}</td>"
            f'<td class="{_cls(day)}">{(f"{day:+.2f}%" if day is not None else "-")}</td>'
            f"<td>{_n(p.market_value_base)}</td>"
            f"<td>{_pl(p.unrealized_pl_base)}</td>"
            f'<td class="{_cls(p.return_pct)}">'
            f'{(f"{p.return_pct:+.2f}%" if p.return_pct is not None else "-")}</td>'
            f"<td>{p.weight:.1f}%</td>"
            f'<td class="l mut">{_e(src)}</td>'
            "</tr>"
        )
    head = ("<tr><th class='l'>종목</th><th class='c'>국가</th><th class='c'>통화</th>"
            "<th>주수</th><th>평단</th><th>현재가</th><th>등락</th>"
            f"<th>평가액({cur})</th><th>손익</th><th>수익률</th><th>비중</th>"
            "<th class='l'>출처</th></tr>")
    return (f'<div class="card"><h2>보유 종목</h2><table>{head}'
            f'{"".join(rows)}</table></div>')


def _breakdown(pf: Portfolio, dim: str, settings: Settings) -> str:
    group = settings.targets.get(dim)
    rows = []
    for b in pf.breakdown(dim):
        target = band = "-"
        verdict = '<span class="tag">-</span>'
        marker = ""
        if group and b.key in group.items:
            item = group.items[b.key]
            lo, hi = item.band(group.tolerance)
            if item.target is not None:
                target = f"{item.target:.1f}%"
                marker = f'<u style="left:{min(item.target, 100):.1f}%"></u>'
            if lo is not None and hi is not None:
                band = f"{lo:.0f}~{hi:.0f}%"
            if hi is not None and b.weight > hi:
                verdict = '<span class="tag sell">초과</span>'
            elif lo is not None and b.weight < lo:
                verdict = '<span class="tag buy">미달</span>'
            else:
                verdict = '<span class="tag ok">적정</span>'
        rows.append(
            "<tr>"
            f'<td class="l">{_e(b.label)}</td>'
            f'<td class="l"><div class="bar" data-weight="{b.weight:.2f}">'
            f'<i style="width:{min(b.weight, 100):.1f}%"></i>{marker}</div></td>'
            f"<td>{b.weight:.1f}%</td><td>{target}</td>"
            f'<td class="c mut">{band}</td><td class="c">{verdict}</td>'
            f"<td>{_n(b.market_value)}</td><td>{_pl(b.unrealized_pl)}</td>"
            "</tr>"
        )
    head = ("<tr><th class='l'>구분</th><th class='l'>비중</th><th>%</th><th>목표</th>"
            "<th class='c'>밴드</th><th class='c'>판정</th><th>평가액</th><th>손익</th></tr>")
    return (f'<div class="card"><h2>{_e(dimension_label(dim))}별 비중</h2>'
            f'<table>{head}{"".join(rows)}</table></div>')


def _plan(pf: Portfolio, signals: list[Signal]) -> str:
    from .rules import consolidate

    plan = consolidate(signals, pf)
    if not plan:
        return ('<div class="card"><h2>실행 요약 (주문서)</h2>'
                '<ul class="plan"><li class="none">모든 항목이 목표 범위 안입니다. '
                '지금 할 매매 없음.</li></ul></div>')
    lis = []
    for item in plan:
        verb = ACTION_KO.get(item.action, item.action)
        cls = "sell" if item.action == "SELL" else "buy"
        tail = f" · 약 {item.shares:,.1f}주" if item.shares else ""
        net = ' <span class="mut">[매수·매도 상계]</span>' if item.netted else ""
        lis.append(
            f'<li><span class="tag {cls}">{verb}</span> <b>{_e(item.label)}</b> · '
            f"{_n(item.amount_base)} {pf.base_currency}{tail}{net}"
            f'<div class="mut">근거: {_e(" | ".join(item.reasons))}</div></li>'
        )
    return ('<div class="card"><h2>실행 요약 (주문서)</h2>'
            '<div class="mut" style="margin:-6px 0 10px">겹치는 규칙은 종목 단위로 합쳐서 '
            '순매매만 표시합니다.</div>'
            f'<ul class="plan">{"".join(lis)}</ul></div>')


def _signals(pf: Portfolio, signals: list[Signal]) -> str:
    rows = []
    for s in signals:
        if s.status == "OK":
            continue
        cls = "bypassed" if s.status == "BYPASSED" else ""
        detail = s.reason
        if s.candidates and s.status == "ACTIVE":
            detail = (detail + " / " if detail else "") + "후보: " + ", ".join(s.candidates)
        rows.append(
            f'<tr class="{cls}">'
            f'<td class="c">{STATUS_KO.get(s.status, s.status)}</td>'
            f'<td class="c">{_e(dimension_label(s.dimension))}</td>'
            f'<td class="l">{_e(s.label)}</td>'
            f'<td class="c">{ACTION_KO.get(s.action, s.action)}</td>'
            f"<td>{_n(s.current_weight, 1)}%</td>"
            f"<td>{(f'{s.target_weight:.1f}%' if s.target_weight is not None else '-')}</td>"
            f"<td>{_n(s.amount_base) if s.amount_base else '-'}</td>"
            f"<td>{(f'{s.shares:,.2f}' if s.shares else '-')}</td>"
            f'<td class="l mut">{_e(detail or "-")}</td>'
            "</tr>"
        )
    if not rows:
        rows.append('<tr><td class="l" colspan="9">해당 없음</td></tr>')
    head = ("<tr><th class='c'>상태</th><th class='c'>구분</th><th class='l'>대상</th>"
            "<th class='c'>액션</th><th>현재</th><th>목표</th>"
            f"<th>금액({pf.base_currency})</th><th>주수</th><th class='l'>사유</th></tr>")
    return (f'<div class="card"><h2>리밸런싱 판정 전체 (예외 처리된 항목 포함)</h2>'
            f'<table>{head}{"".join(rows)}</table></div>')


def _raw_json(pf: Portfolio, signals: list[Signal], book: QuoteBook) -> str:
    from .exporter import to_dict

    payload = json.dumps(to_dict(pf, signals, book), ensure_ascii=False, indent=1)
    return ('<div class="card"><details><summary>원본 데이터(JSON) - 차트 붙일 때 사용</summary>'
            f'<pre id="portfolio-data">{_e(payload)}</pre></details></div>')
