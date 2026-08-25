"""터미널 리포트. 한글 폭(2칸)을 고려해서 표를 정렬한다."""

from __future__ import annotations

import unicodedata

from .config import Settings
from .engine import Portfolio
from .models import Signal
from .quotes import QuoteBook
from .rules import dimension_label

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
RED = "\033[31m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
BLUE = "\033[36m"

_COLOR = True


def use_color(flag: bool) -> None:
    global _COLOR
    _COLOR = flag


def c(text: str, color: str) -> str:
    return f"{color}{text}{RESET}" if _COLOR else text


def width(s: str) -> int:
    return sum(2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in str(s))


def pad(s: str, n: int, align: str = "left") -> str:
    s = str(s)
    gap = max(0, n - width(s))
    if align == "right":
        return " " * gap + s
    if align == "center":
        left = gap // 2
        return " " * left + s + " " * (gap - left)
    return s + " " * gap


def table(headers: list[str], rows: list[list[str]], aligns: list[str] | None = None,
          colors: list[str | None] | None = None) -> str:
    aligns = aligns or ["left"] * len(headers)
    widths = [width(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], width(cell))
    out = ["  ".join(c(pad(h, widths[i], aligns[i]), BOLD) for i, h in enumerate(headers))]
    out.append(c("─" * (sum(widths) + 2 * (len(widths) - 1)), DIM))
    for j, row in enumerate(rows):
        line = "  ".join(pad(cell, widths[i], aligns[i]) for i, cell in enumerate(row))
        if colors and colors[j]:
            line = c(line, colors[j])
        out.append(line)
    return "\n".join(out)


def money(v: float | None, currency: str = "") -> str:
    if v is None:
        return "-"
    suffix = f" {currency}" if currency else ""
    return f"{v:,.0f}{suffix}"


def pct(v: float | None, sign: bool = False) -> str:
    if v is None:
        return "-"
    return f"{v:+.2f}%" if sign else f"{v:.2f}%"


def signed(v: float | None) -> str:
    if v is None:
        return "-"
    return f"{v:+,.0f}"


def pl_color(v: float | None) -> str:
    if v is None or abs(v) < 1e-9:
        return ""
    return RED if v > 0 else BLUE  # 국내 관행: 상승 빨강 / 하락 파랑


def header(title: str) -> str:
    return f"\n{c('■ ' + title, BOLD)}"


# ---------------------------------------------------------------- 화면들
def render_summary(pf: Portfolio, book: QuoteBook) -> str:
    cur = pf.base_currency
    lines = [header("총괄")]
    rows = [
        ["평가금액", money(pf.total_value, cur)],
        ["매입금액", money(pf.total_cost, cur)],
        ["평가손익", f"{signed(pf.unrealized_pl)} ({pct(pf.return_pct, sign=True)})"],
        ["당일손익", signed(pf.day_pl)],
        ["실현손익(누적)", signed(pf.realized_pl)],
        ["현금", money(pf.cash, cur)],
        ["보유종목", f"{len(pf.positions)}개 / 실질분산 {pf.effective_holdings:.1f}개"],
        ["집중도", f"상위3종목 {pf.top_concentration:.1f}% · HHI {pf.hhi:,.0f}"],
    ]
    lines.append(table(["항목", "값"], rows, ["left", "right"]))
    if pf.missing_prices:
        lines.append(c(f"  ! 시세/환율 미확보: {', '.join(pf.missing_prices)}", YELLOW))
    if book.any_stale:
        lines.append(c("  ! 일부 시세가 캐시(과거) 값입니다. --refresh 로 갱신하세요.", YELLOW))
    return "\n".join(lines)


def render_positions(pf: Portfolio) -> str:
    cur = pf.base_currency
    headers = ["종목", "국가", "통화", "주수", "평단", "현재가", "등락",
               f"평가액({cur})", "손익", "수익률", "비중", "출처"]
    aligns = ["left", "center", "center", "right", "right", "right", "right",
              "right", "right", "right", "right", "left"]
    rows, colors = [], []
    for p in pf.positions:
        q = p.quote
        day = q.day_change_pct if q else None
        rows.append([
            f"{p.asset.name}({p.asset.ticker})",
            p.asset.country,
            p.asset.currency,
            f"{p.quantity:,.4g}",
            f"{p.avg_price_local:,.2f}",
            f"{p.price_local:,.2f}" if p.price_local is not None else "-",
            pct(day, sign=True),
            money(p.market_value_base),
            signed(p.unrealized_pl_base),
            pct(p.return_pct, sign=True),
            f"{p.weight:.1f}%",
            (q.source + ("*" if q.stale else "")) if q else "미확보",
        ])
        colors.append(pl_color(p.unrealized_pl_base))
    return header("보유 종목") + "\n" + table(headers, rows, aligns, colors)


def render_breakdown(pf: Portfolio, dim: str, settings: Settings) -> str:
    buckets = pf.breakdown(dim)
    if not buckets:
        return ""
    group = settings.targets.get(dim)
    cur = pf.base_currency
    headers = ["구분", f"평가액({cur})", "비중", "목표", "허용밴드", "판정", "손익", "수익률"]
    aligns = ["left", "right", "right", "right", "center", "center", "right", "right"]
    rows, colors = [], []
    for b in buckets:
        target = band = verdict = "-"
        if group and b.key in group.items:
            item = group.items[b.key]
            lo, hi = item.band(group.tolerance)
            target = f"{item.target:.1f}%" if item.target is not None else "-"
            band = f"{lo:.1f}~{hi:.1f}%" if lo is not None and hi is not None else "-"
            if hi is not None and b.weight > hi:
                verdict = "초과↑"
            elif lo is not None and b.weight < lo:
                verdict = "미달↓"
            else:
                verdict = "적정"
        rows.append([
            b.label, money(b.market_value), f"{b.weight:.1f}%", target, band, verdict,
            signed(b.unrealized_pl), pct(b.return_pct, sign=True),
        ])
        colors.append({"초과↑": YELLOW, "미달↓": YELLOW}.get(verdict, ""))
    return header(f"{dimension_label(dim)}별 비중") + "\n" + table(headers, rows, aligns, colors)


ACTION_KO = {"BUY": "매수", "SELL": "매도", "HOLD": "유지"}
STATUS_KO = {"ACTIVE": "실행", "BYPASSED": "예외", "MUTED": "참고", "OK": "적정"}


def render_signals(signals: list[Signal], pf: Portfolio, show_all: bool = False) -> str:
    cur = pf.base_currency
    shown = [s for s in signals if show_all or s.status in ("ACTIVE", "BYPASSED")]
    if not shown:
        return header("리밸런싱 안내") + "\n  모든 항목이 목표 범위 안에 있습니다. 매매 불필요."

    headers = ["상태", "구분", "대상", "액션", "현재", "목표", "금액(" + cur + ")", "주수", "사유/후보"]
    aligns = ["center", "center", "left", "center", "right", "right", "right", "right", "left"]
    rows, colors = [], []
    for s in shown:
        detail = s.reason
        if s.candidates and s.status == "ACTIVE":
            detail = (detail + " / " if detail else "") + "후보: " + ", ".join(s.candidates)
        rows.append([
            STATUS_KO.get(s.status, s.status),
            dimension_label(s.dimension),
            s.label,
            ACTION_KO.get(s.action, s.action),
            pct(s.current_weight),
            pct(s.target_weight) if s.target_weight is not None else "-",
            money(s.amount_base) if s.amount_base else "-",
            f"{s.shares:,.2f}" if s.shares else "-",
            detail or "-",
        ])
        if s.status == "BYPASSED":
            colors.append(DIM)
        elif s.action == "SELL":
            colors.append(RED)
        elif s.action == "BUY":
            colors.append(GREEN)
        else:
            colors.append("")
    return header("리밸런싱 안내") + "\n" + table(headers, rows, aligns, colors)


def render_plan(signals: list[Signal], pf: Portfolio) -> str:
    from .rules import consolidate

    plan = consolidate(signals, pf)
    if not plan:
        return header("실행 요약 (주문서)") + "\n  " + c("지금 할 매매 없음.", GREEN)
    lines = [header("실행 요약 (주문서)"),
             c("  겹치는 규칙은 종목 단위로 합쳐서 순매매만 표시합니다.", DIM)]
    for i, item in enumerate(plan, 1):
        verb = ACTION_KO.get(item.action, item.action)
        color = RED if item.action == "SELL" else GREEN
        tail = f" (약 {item.shares:,.1f}주)" if item.shares else ""
        net = c(" [매수·매도 상계]", DIM) if item.netted else ""
        lines.append(
            f"  {i}. " + c(f"[{verb}]", color)
            + f" {item.label} · {money(item.amount_base, pf.base_currency)}{tail}{net}"
        )
        lines.append(c(f"       근거: {' | '.join(item.reasons)}", DIM))
    return "\n".join(lines)


def render_fetch_log(book: QuoteBook, verbose: bool = False) -> str:
    lines = [header("시세 수집")]
    src = ", ".join(f"{k} {v}건" for k, v in sorted(book.sources.items())) or "없음"
    lines.append(f"  공급자: {src}")
    fx = ", ".join(
        f"{k}→{book.fx.base} {v:,.4g}" for k, v in book.fx.rates.items() if k != book.fx.base
    )
    lines.append(f"  환율: {fx or '-'}")
    if verbose:
        lines.extend("  " + line for line in book.log)
    else:
        problems = [line for line in book.log if line.startswith(("!", "  x", "  ->"))]
        lines.extend("  " + line.strip() for line in problems)
    return "\n".join(lines)
