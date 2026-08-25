"""핵심 데이터 모델."""

from __future__ import annotations

import datetime as dt
import hashlib
from dataclasses import dataclass, field
from typing import Optional


@dataclass
class Asset:
    """종목 메타데이터 (settings.yaml 의 assets 섹션)."""

    ticker: str
    name: str = ""
    country: str = "??"
    currency: str = "USD"
    exchange: str = ""
    sector: str = "기타"
    asset_class: str = "주식"
    tags: list[str] = field(default_factory=list)
    symbols: dict[str, str] = field(default_factory=dict)  # provider -> symbol
    note: str = ""

    def symbol_for(self, provider: str) -> Optional[str]:
        return self.symbols.get(provider)


@dataclass
class Transaction:
    """매수/매도 1건 (사용자가 직접 입력하는 구매 이력)."""

    date: dt.date
    ticker: str
    side: str  # BUY | SELL
    quantity: float
    price: float  # 종목 통화 기준 단가
    fee: float = 0.0
    account: str = "기본"
    note: str = ""
    id: str = ""  # 앱에서 수정·삭제할 때 쓰는 고유값. 비어 있으면 자동 생성

    @property
    def natural_key(self) -> tuple:
        return (self.date, self.ticker, self.side, self.quantity, self.price, self.account)

    def ensure_id(self) -> str:
        if not self.id:
            raw = "|".join(str(x) for x in self.natural_key)
            self.id = "tx_" + hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]
        return self.id

    @property
    def signed_qty(self) -> float:
        return self.quantity if self.side == "BUY" else -self.quantity

    @property
    def gross(self) -> float:
        return self.quantity * self.price


@dataclass
class Quote:
    """시세 1건."""

    ticker: str
    price: float
    currency: str
    previous_close: Optional[float] = None
    source: str = "unknown"
    as_of: Optional[dt.datetime] = None
    stale: bool = False  # 캐시/스냅샷에서 온 값이면 True

    @property
    def day_change_pct(self) -> Optional[float]:
        if not self.previous_close:
            return None
        return (self.price - self.previous_close) / self.previous_close * 100.0

    def to_dict(self) -> dict:
        return {
            "ticker": self.ticker,
            "price": self.price,
            "currency": self.currency,
            "previous_close": self.previous_close,
            "source": self.source,
            "as_of": self.as_of.isoformat() if self.as_of else None,
            "stale": self.stale,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Quote":
        as_of = d.get("as_of")
        return cls(
            ticker=d["ticker"],
            price=float(d["price"]),
            currency=d.get("currency", "USD"),
            previous_close=(float(d["previous_close"]) if d.get("previous_close") else None),
            source=d.get("source", "cache"),
            as_of=dt.datetime.fromisoformat(as_of) if as_of else None,
            stale=bool(d.get("stale", False)),
        )


@dataclass
class Position:
    """보유 종목 1개의 계산 결과."""

    asset: Asset
    quantity: float = 0.0
    cost_basis_local: float = 0.0  # 총 매입금액(수수료 포함, 종목통화)
    realized_pl_local: float = 0.0
    accounts: set[str] = field(default_factory=set)
    first_buy: Optional[dt.date] = None
    last_trade: Optional[dt.date] = None
    quote: Optional[Quote] = None
    fx_rate: float = 1.0  # 종목통화 -> 기준통화
    weight: float = 0.0  # 전체 대비 비중 (%)
    # 시세를 못 받은 종목은 산 값으로 쳐서 비중을 낸다 (engine 에서 채운다)
    value_base: float = 0.0
    valued_at_cost: bool = False

    # ---- 단가 / 평가 ----
    @property
    def avg_price_local(self) -> float:
        return self.cost_basis_local / self.quantity if self.quantity else 0.0

    @property
    def price_local(self) -> Optional[float]:
        return self.quote.price if self.quote else None

    @property
    def market_value_local(self) -> Optional[float]:
        if self.price_local is None:
            return None
        return self.price_local * self.quantity

    @property
    def market_value_base(self) -> Optional[float]:
        mv = self.market_value_local
        return None if mv is None else mv * self.fx_rate

    @property
    def cost_basis_base(self) -> float:
        return self.cost_basis_local * self.fx_rate

    @property
    def unrealized_pl_local(self) -> Optional[float]:
        mv = self.market_value_local
        return None if mv is None else mv - self.cost_basis_local

    @property
    def unrealized_pl_base(self) -> Optional[float]:
        pl = self.unrealized_pl_local
        return None if pl is None else pl * self.fx_rate

    @property
    def return_pct(self) -> Optional[float]:
        pl = self.unrealized_pl_local
        if pl is None or not self.cost_basis_local:
            return None
        return pl / self.cost_basis_local * 100.0

    @property
    def day_pl_base(self) -> Optional[float]:
        if not self.quote or self.quote.previous_close is None:
            return None
        return (self.quote.price - self.quote.previous_close) * self.quantity * self.fx_rate


@dataclass
class Signal:
    """리밸런싱 안내 1건."""

    dimension: str  # country | ticker | sector | currency | account | asset_class | rule
    key: str
    label: str
    action: str  # BUY | SELL | HOLD
    status: str  # ACTIVE | BYPASSED | MUTED
    current_weight: Optional[float] = None
    target_weight: Optional[float] = None
    min_weight: Optional[float] = None
    max_weight: Optional[float] = None
    gap_pp: Optional[float] = None  # 현재-목표 (%p)
    amount_base: float = 0.0  # 조정 필요 금액(기준통화, 양수)
    shares: Optional[float] = None
    reason: str = ""
    candidates: list[str] = field(default_factory=list)  # 화면 표시용 "이름(티커)"
    candidate_tickers: list[str] = field(default_factory=list)  # 실행 대상 티커

    @property
    def is_actionable(self) -> bool:
        return self.status == "ACTIVE" and self.action in ("BUY", "SELL")


@dataclass
class PlanItem:
    """여러 규칙을 종목 단위로 합친 최종 주문서 1줄."""

    ticker: str
    label: str
    action: str  # BUY | SELL
    amount_base: float
    shares: Optional[float] = None
    reasons: list[str] = field(default_factory=list)
    netted: bool = False  # 매수/매도 신호가 상충해서 상계된 경우
