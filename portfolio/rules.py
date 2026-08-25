"""리밸런싱 규칙 엔진.

국가별 / 종목별 / 섹터별 목표 비중을 벗어나면 매수·매도 신호를 만든다.
모든 신호는 bypass(예외 처리) 로 무력화할 수 있고, 무력화된 신호도 리포트에는
'BYPASS + 사유' 로 남겨서 왜 안내가 안 나왔는지 추적 가능하게 한다.

status 값
  ACTIVE   실제로 실행을 권하는 신호
  BYPASSED 사용자가 예외 처리해서 실행 대상에서 제외
  MUTED    조건은 걸렸지만 금액이 너무 작거나(min_trade_amount) 목표 미설정이라 참고용
"""

from __future__ import annotations

import datetime as dt

from .config import BypassEntry, Settings, DIMENSION_LABELS
from .engine import Portfolio
from .models import PlanItem, Signal

DEFAULT_MIN_TRADE = 0.0


class BypassRegistry:
    """설정 파일 + CLI 옵션에서 모은 예외 규칙."""

    def __init__(self, settings: Settings, extra: list[str] | None = None,
                 disabled: bool = False, today: dt.date | None = None):
        self.enabled = settings.bypass_enabled and not disabled
        self.today = today or dt.date.today()
        self.entries: list[BypassEntry] = list(settings.bypass_entries)
        for spec in extra or []:
            self.entries.append(_parse_bypass_spec(spec))
        self.hits: set[tuple[str, str]] = set()

    def check(self, dimension: str, key: str) -> BypassEntry | None:
        if not self.enabled:
            return None
        for e in self.entries:
            if not e.active(self.today):
                continue
            scope_ok = e.scope in ("all", "*") or e.scope == dimension
            key_ok = e.key in ("*", "") or e.key.upper() == key.upper()
            if scope_ok and key_ok:
                self.hits.add((e.scope, e.key))
                return e
        return None

    @property
    def unused(self) -> list[BypassEntry]:
        """설정했지만 이번에 한 번도 안 걸린 예외 (오타/기간만료 점검용)."""
        return [
            e for e in self.entries
            if not e.active(self.today) or (e.scope, e.key) not in self.hits
        ]


def _parse_bypass_spec(spec: str) -> BypassEntry:
    """'TSLA' / 'ticker:TSLA' / 'country:VN=환전 이슈' 형태를 파싱."""
    scope, _, rest = spec.partition(":")
    if not rest:
        scope, rest = "ticker", scope
    key, _, reason = rest.partition("=")
    return BypassEntry(scope=scope.strip(), key=key.strip(),
                       reason=reason.strip() or "CLI 옵션으로 예외 처리")


def evaluate(pf: Portfolio, settings: Settings,
             bypass: BypassRegistry | None = None) -> list[Signal]:
    bypass = bypass or BypassRegistry(settings)
    signals: list[Signal] = []
    total = pf.total_value
    if not total:
        return signals

    min_trade = float(settings.rules.get("min_trade_amount", DEFAULT_MIN_TRADE) or 0)

    for dim, group in settings.targets.items():
        if not group.enabled:
            continue
        buckets = {b.key: b for b in pf.breakdown(dim)}
        seen = set()

        for key, item in group.items.items():
            seen.add(key)
            bucket = buckets.get(key)
            current = bucket.weight if bucket else 0.0
            lo, hi = item.band(group.tolerance)
            label = bucket.label if bucket else key

            if hi is not None and current > hi:
                action, anchor = "SELL", (item.target if item.target is not None else hi)
            elif lo is not None and current < lo:
                action, anchor = "BUY", (item.target if item.target is not None else lo)
            else:
                action, anchor = "HOLD", (item.target if item.target is not None else current)

            gap_pp = current - (item.target if item.target is not None else current)
            amount = abs(current - anchor) / 100.0 * total if action != "HOLD" else 0.0

            sig = Signal(
                dimension=dim,
                key=key,
                label=label,
                action=action,
                status="ACTIVE" if action != "HOLD" else "OK",
                current_weight=current,
                target_weight=item.target,
                min_weight=lo,
                max_weight=hi,
                gap_pp=gap_pp,
                amount_base=amount,
                reason=item.note,
            )
            _finalize(sig, pf, settings, bypass, item.bypass, min_trade)
            signals.append(sig)

        # 목표를 안 정한 그룹도 화면에는 보여준다 (참고용)
        for key, bucket in buckets.items():
            if key in seen:
                continue
            signals.append(Signal(
                dimension=dim, key=key, label=bucket.label, action="HOLD", status="MUTED",
                current_weight=bucket.weight, reason="목표 비중 미설정",
            ))

    signals.extend(_position_rules(pf, settings, bypass, min_trade))
    order = {"SELL": 0, "BUY": 1, "HOLD": 2}
    signals.sort(key=lambda s: (
        0 if s.status == "ACTIVE" else 1 if s.status == "BYPASSED" else 2,
        order.get(s.action, 3),
        -(s.amount_base or 0),
    ))
    return signals


def _position_rules(pf: Portfolio, settings: Settings, bypass: BypassRegistry,
                    min_trade: float) -> list[Signal]:
    """비중 상·하한, 익절/손절 같은 종목 단위 안전장치."""
    out: list[Signal] = []
    r = settings.rules
    max_w = _f(r.get("max_position_weight"))
    min_w = _f(r.get("min_position_weight"))
    tp = _f(r.get("take_profit_pct"))
    sl = _f(r.get("stop_loss_pct"))
    total = pf.total_value

    for p in pf.positions:
        t = p.asset.ticker
        name = f"{p.asset.name}({t})"

        if max_w is not None and p.weight > max_w:
            amount = (p.weight - max_w) / 100.0 * total
            s = Signal("rule", t, name, "SELL", "ACTIVE",
                       current_weight=p.weight, max_weight=max_w, amount_base=amount,
                       reason=f"1종목 비중 상한 {max_w:g}% 초과")
            _finalize(s, pf, settings, bypass, False, min_trade)
            out.append(s)

        if min_w is not None and 0 < p.weight < min_w:
            amount = (min_w - p.weight) / 100.0 * total
            s = Signal("rule", t, name, "BUY", "ACTIVE",
                       current_weight=p.weight, min_weight=min_w, amount_base=amount,
                       reason=f"자투리 종목 - 비중 하한 {min_w:g}% 미만 (정리 또는 추가매수)")
            _finalize(s, pf, settings, bypass, False, min_trade)
            out.append(s)

        ret = p.return_pct
        if ret is None:
            continue
        if tp is not None and ret >= tp:
            s = Signal("rule", t, name, "SELL", "ACTIVE",
                       current_weight=p.weight, amount_base=(p.market_value_base or 0) * 0.25,
                       reason=f"목표 수익률 도달 (+{ret:.1f}% ≥ {tp:g}%) - 일부 익절 검토")
            _finalize(s, pf, settings, bypass, False, min_trade)
            out.append(s)
        if sl is not None and ret <= sl:
            s = Signal("rule", t, name, "SELL", "ACTIVE",
                       current_weight=p.weight, amount_base=(p.market_value_base or 0),
                       reason=f"손절선 이탈 ({ret:.1f}% ≤ {sl:g}%) - 대응 필요")
            _finalize(s, pf, settings, bypass, False, min_trade)
            out.append(s)
    return out


def _finalize(sig: Signal, pf: Portfolio, settings: Settings,
              bypass: BypassRegistry, item_bypass: bool, min_trade: float) -> None:
    """주수 환산 + 후보 종목 + bypass 적용."""
    if sig.action in ("BUY", "SELL"):
        _attach_execution(sig, pf)

    if sig.status != "ACTIVE":
        return

    if item_bypass:
        sig.status = "BYPASSED"
        sig.reason = _join(sig.reason, "설정에서 이 항목 예외 처리(bypass: true)")
        return

    hit = bypass.check(sig.dimension, sig.key)
    if hit is None and sig.dimension == "rule":
        hit = bypass.check("ticker", sig.key)
    if hit:
        sig.status = "BYPASSED"
        until = f", ~{hit.until}" if hit.until else ""
        sig.reason = _join(sig.reason, f"BYPASS: {hit.reason or '사유 미기재'}{until}")
        return

    if min_trade and sig.amount_base < min_trade:
        sig.status = "MUTED"
        sig.reason = _join(sig.reason, f"조정금액이 최소 매매금액({min_trade:,.0f}) 미만")


def _attach_execution(sig: Signal, pf: Portfolio) -> None:
    """신호를 '몇 주' 수준까지 내려준다."""
    by_ticker = {p.asset.ticker: p for p in pf.positions}
    pos = by_ticker.get(sig.key)

    if pos is not None:
        price_base = (pos.price_local or 0) * pos.fx_rate
        if price_base:
            shares = sig.amount_base / price_base
            if sig.action == "SELL":
                shares = min(shares, pos.quantity)
            sig.shares = shares
        sig.candidates = [sig.key]
        sig.candidate_tickers = [sig.key]
        return

    # 국가/섹터 같은 그룹 신호: 그룹 안에서 실행 후보를 골라준다.
    members = [p for p in pf.positions if _member_of(p, sig.dimension, sig.key)]
    if not members:
        return
    if sig.action == "SELL":
        # 많이 오른 / 비중 큰 종목부터 덜어내는 게 자연스럽다
        members.sort(key=lambda p: (p.return_pct or 0, p.weight), reverse=True)
    else:
        # 덜 오른 / 비중 작은 종목부터 채운다
        members.sort(key=lambda p: (p.return_pct if p.return_pct is not None else 0, p.weight))
    sig.candidates = [f"{p.asset.name}({p.asset.ticker})" for p in members[:3]]
    sig.candidate_tickers = [p.asset.ticker for p in members[:3]]


def _member_of(pos, dimension: str, key: str) -> bool:
    getters = {
        "country": lambda p: p.asset.country,
        "sector": lambda p: p.asset.sector,
        "currency": lambda p: p.asset.currency,
        "asset_class": lambda p: p.asset.asset_class,
        "ticker": lambda p: p.asset.ticker,
    }
    if dimension == "tag":
        return key in pos.asset.tags
    if dimension == "account":
        return key in pos.accounts
    fn = getters.get(dimension)
    return bool(fn and fn(pos) == key)


def action_plan(signals: list[Signal]) -> list[Signal]:
    """실제로 실행을 권하는 신호만 (원본 그대로)."""
    return [s for s in signals if s.is_actionable]


def consolidate(signals: list[Signal], pf: Portfolio) -> list[PlanItem]:
    """겹치는 규칙을 종목 단위 주문서 한 장으로 합친다.

    - 같은 종목에 같은 방향 신호가 여러 개면 '가장 큰 금액'을 쓴다(합산 아님).
      국가 초과 + 섹터 초과 + 종목 초과가 사실상 같은 매도를 가리키기 때문.
    - 매수/매도가 동시에 걸리면 상계해서 순매매만 남긴다.
    """
    by_ticker: dict[str, dict[str, tuple[float, list[str]]]] = {}

    for s in signals:
        if not s.is_actionable:
            continue
        ticker = s.candidate_tickers[0] if s.candidate_tickers else s.key
        tag = f"{dimension_label(s.dimension)}:{s.label}"
        if s.reason:
            tag += f" ({s.reason.split(' / ')[0]})"
        slot = by_ticker.setdefault(ticker, {})
        amount, reasons = slot.get(s.action, (0.0, []))
        slot[s.action] = (max(amount, s.amount_base), reasons + [tag])

    positions = {p.asset.ticker: p for p in pf.positions}
    plan: list[PlanItem] = []
    for ticker, actions in by_ticker.items():
        sell_amt, sell_reasons = actions.get("SELL", (0.0, []))
        buy_amt, buy_reasons = actions.get("BUY", (0.0, []))
        netted = bool(sell_amt and buy_amt)
        amount = sell_amt - buy_amt
        action = "SELL" if amount > 0 else "BUY"
        amount = abs(amount)
        if amount < 1e-6:
            continue

        pos = positions.get(ticker)
        label = f"{pos.asset.name}({ticker})" if pos else ticker
        shares = None
        if pos:
            price_base = (pos.price_local or 0) * pos.fx_rate
            if price_base:
                shares = amount / price_base
                if action == "SELL":
                    shares = min(shares, pos.quantity)
        plan.append(PlanItem(
            ticker=ticker, label=label, action=action, amount_base=amount,
            shares=shares, reasons=(sell_reasons + buy_reasons), netted=netted,
        ))

    plan.sort(key=lambda i: (0 if i.action == "SELL" else 1, -i.amount_base))
    return plan


def dimension_label(dim: str) -> str:
    return DIMENSION_LABELS.get(dim, "개별규칙" if dim == "rule" else dim)


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _join(a: str, b: str) -> str:
    return f"{a} / {b}" if a else b
