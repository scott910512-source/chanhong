"""시세 공급자 레지스트리."""

from __future__ import annotations

from .base import Provider
from .keyed import (
    AlphaVantageProvider,
    FinnhubProvider,
    MarketstackProvider,
    TwelveDataProvider,
)
from .naver import NaverProvider
from .stooq import StooqProvider
from .vietnam import VietnamProvider
from .yahoo import YahooProvider

ALL_PROVIDERS: dict[str, type[Provider]] = {
    p.name: p
    for p in (
        YahooProvider,
        NaverProvider,
        VietnamProvider,
        StooqProvider,
        FinnhubProvider,
        TwelveDataProvider,
        AlphaVantageProvider,
        MarketstackProvider,
    )
}

DEFAULT_ORDER = [
    "yahoo",
    "naver",
    "vietnam",
    "stooq",
    "finnhub",
    "twelvedata",
    "marketstack",
    "alphavantage",
]


def build(order: list[str] | None = None, timeout: float = 10.0) -> list[Provider]:
    """설정 순서대로 사용 가능한 공급자 인스턴스를 만든다."""
    names = order or DEFAULT_ORDER
    out: list[Provider] = []
    for n in names:
        cls = ALL_PROVIDERS.get(n)
        if cls is None:
            continue
        inst = cls(timeout=timeout)
        if inst.available():
            out.append(inst)
    return out


__all__ = ["ALL_PROVIDERS", "DEFAULT_ORDER", "Provider", "build"]
