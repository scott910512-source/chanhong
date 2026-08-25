"""포트폴리오 계산 엔진.

거래내역 -> 보유 포지션(수량/평단/평가금액/손익/비중) -> 그룹별 집계 -> 위험지표
평단은 이동평균법(매도 시 평단 유지, 실현손익 분리)으로 계산한다.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import DIMENSION_LABELS, Settings
from .models import Position, Transaction
from .quotes import QuoteBook


@dataclass
class Bucket:
    """그룹(국가/섹터/…) 하나의 집계값."""

    key: str
    label: str
    market_value: float = 0.0
    cost_basis: float = 0.0
    day_pl: float = 0.0
    weight: float = 0.0
    tickers: list[str] = field(default_factory=list)

    @property
    def unrealized_pl(self) -> float:
        return self.market_value - self.cost_basis

    @property
    def return_pct(self) -> float | None:
        return (self.unrealized_pl / self.cost_basis * 100.0) if self.cost_basis else None


@dataclass
class Portfolio:
    base_currency: str
    positions: list[Position]
    breakdowns: dict[str, list[Bucket]]
    cash: float = 0.0
    realized_pl: float = 0.0
    priced_value: float = 0.0  # 시세를 받은 종목의 평가금액 합
    missing_prices: list[str] = field(default_factory=list)

    @property
    def total_value(self) -> float:
        """현금 포함 총 자산 (비중 계산 기준)."""
        return self.priced_value + self.cash

    @property
    def total_cost(self) -> float:
        return sum(p.cost_basis_base for p in self.positions if p.quote)

    @property
    def unrealized_pl(self) -> float:
        return sum(p.unrealized_pl_base or 0.0 for p in self.positions)

    @property
    def day_pl(self) -> float:
        return sum(p.day_pl_base or 0.0 for p in self.positions)

    @property
    def return_pct(self) -> float | None:
        return (self.unrealized_pl / self.total_cost * 100.0) if self.total_cost else None

    def breakdown(self, dimension: str) -> list[Bucket]:
        return self.breakdowns.get(dimension, [])

    # ---- 추천 위험지표 ----
    @property
    def hhi(self) -> float:
        """허핀달 집중도 지수(0~10000). 2500 이상이면 상당히 몰려 있다는 뜻."""
        return sum((p.weight) ** 2 for p in self.positions)

    @property
    def effective_holdings(self) -> float:
        """실질 분산 종목 수 = 10000 / HHI."""
        return 10000.0 / self.hhi if self.hhi else 0.0

    @property
    def top_concentration(self) -> float:
        """상위 3종목 합산 비중(%)."""
        return sum(sorted((p.weight for p in self.positions), reverse=True)[:3])


def build_positions(txs: list[Transaction], settings: Settings,
                    include_closed: bool = False) -> list[Position]:
    """거래내역을 종목별 포지션으로 접는다.

    include_closed=True 면 전량 매도해서 수량이 0 인 종목도 (실현손익 확인용) 남긴다.
    """
    positions: dict[str, Position] = {}

    for tx in txs:
        asset = settings.asset(tx.ticker)
        pos = positions.get(tx.ticker)
        if pos is None:
            pos = positions[tx.ticker] = Position(asset=asset)
        pos.accounts.add(tx.account)
        pos.last_trade = tx.date if not pos.last_trade else max(pos.last_trade, tx.date)

        if tx.side == "BUY":
            pos.first_buy = tx.date if not pos.first_buy else min(pos.first_buy, tx.date)
            pos.quantity += tx.quantity
            pos.cost_basis_local += tx.gross + tx.fee
        else:  # SELL - 이동평균법
            if tx.quantity > pos.quantity + 1e-9:
                raise ValueError(
                    f"{tx.ticker} {tx.date}: 보유({pos.quantity:g})보다 많은 수량을 "
                    f"매도({tx.quantity:g})했습니다. 거래내역을 확인하세요."
                )
            avg = pos.avg_price_local
            cost_out = avg * tx.quantity
            pos.quantity -= tx.quantity
            pos.cost_basis_local -= cost_out
            pos.realized_pl_local += tx.gross - cost_out - tx.fee
            if pos.quantity <= 1e-9:
                pos.quantity = 0.0
                pos.cost_basis_local = 0.0

    if include_closed:
        return list(positions.values())
    return [p for p in positions.values() if p.quantity > 0]


def build_portfolio(txs: list[Transaction], settings: Settings, book: QuoteBook,
                    cash: float = 0.0) -> Portfolio:
    all_positions = build_positions(txs, settings, include_closed=True)
    positions = [p for p in all_positions if p.quantity > 0]

    def _fx(currency: str) -> float:
        rate = book.fx.rate(currency)
        if rate is not None:
            return rate
        return 1.0 if currency == settings.base_currency else 0.0

    for pos in all_positions:
        pos.fx_rate = _fx(pos.asset.currency)
    for pos in positions:
        pos.quote = book.get(pos.asset.ticker)

    realized_total = sum(p.realized_pl_local * p.fx_rate for p in all_positions)

    priced = sum(p.market_value_base or 0.0 for p in positions)
    total = priced + cash
    for pos in positions:
        mv = pos.market_value_base
        pos.weight = (mv / total * 100.0) if (total and mv) else 0.0

    missing = [p.asset.ticker for p in positions if p.quote is None or not p.fx_rate]

    pf = Portfolio(
        base_currency=settings.base_currency,
        positions=sorted(positions, key=lambda p: p.market_value_base or 0, reverse=True),
        breakdowns={},
        cash=cash,
        realized_pl=realized_total,
        priced_value=priced,
        missing_prices=missing,
    )
    pf.breakdowns = build_breakdowns(pf)
    return pf


DIMENSION_KEYS = {
    "country": lambda p: [p.asset.country],
    "sector": lambda p: [p.asset.sector],
    "currency": lambda p: [p.asset.currency],
    "asset_class": lambda p: [p.asset.asset_class],
    "account": lambda p: sorted(p.accounts) or ["기본"],
    "tag": lambda p: p.asset.tags or ["-"],
    "ticker": lambda p: [p.asset.ticker],
}


def build_breakdowns(pf: Portfolio) -> dict[str, list[Bucket]]:
    out: dict[str, list[Bucket]] = {}
    for dim, keyfn in DIMENSION_KEYS.items():
        buckets: dict[str, Bucket] = {}
        for p in pf.positions:
            mv = p.market_value_base
            if mv is None:
                continue
            keys = keyfn(p)
            share = 1.0 / len(keys)  # 태그/계좌가 여러 개면 균등 분할
            for k in keys:
                b = buckets.get(k)
                if b is None:
                    b = buckets[k] = Bucket(key=k, label=_label(dim, k, p))
                b.market_value += mv * share
                b.cost_basis += p.cost_basis_base * share
                b.day_pl += (p.day_pl_base or 0.0) * share
                b.tickers.append(p.asset.ticker)
        total = pf.total_value
        for b in buckets.values():
            b.weight = (b.market_value / total * 100.0) if total else 0.0
        out[dim] = sorted(buckets.values(), key=lambda b: b.market_value, reverse=True)
    if pf.cash:
        out.setdefault("asset_class", []).append(
            Bucket(key="현금", label="현금", market_value=pf.cash, cost_basis=pf.cash,
                   weight=(pf.cash / pf.total_value * 100.0) if pf.total_value else 0.0)
        )
    return out


COUNTRY_NAMES = {
    "KR": "대한민국", "US": "미국", "VN": "베트남", "JP": "일본",
    "CN": "중국", "HK": "홍콩", "TW": "대만", "DE": "독일", "GB": "영국",
}


def _label(dim: str, key: str, pos: Position) -> str:
    if dim == "country":
        return f"{COUNTRY_NAMES.get(key, key)}({key})"
    if dim == "ticker":
        return f"{pos.asset.name}({key})"
    return key


def dimension_label(dim: str) -> str:
    return DIMENSION_LABELS.get(dim, dim)
