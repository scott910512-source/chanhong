"""Stooq CSV - 키 없이 쓰는 폴백. 미국/유럽 종목과 환율에 강하다.

심볼 규칙: 미국 aapl.us / 환율 usdkrw
"""

from __future__ import annotations

from ..httpx import FetchError, fetch_csv
from ..models import Asset, Quote
from .base import Provider

SUFFIX = {"US": ".us", "DE": ".de", "GB": ".uk", "JP": ".jp", "PL": ".pl"}


class StooqProvider(Provider):
    name = "stooq"
    label = "Stooq"
    countries = {"US", "DE", "GB", "JP", "PL"}
    rate_limit_note = "키 불필요 / 종가 위주(15분~1일 지연)"

    def symbol(self, asset: Asset) -> str:
        override = asset.symbol_for(self.name)
        if override:
            return override
        return asset.ticker.lower() + SUFFIX.get(asset.country.upper(), "")

    def get_quote(self, asset: Asset) -> Quote:
        sym = self.symbol(asset)
        price = self.raw_price(sym)
        return super()._quote(asset, price, self._previous_close(sym))

    # ---- 환율 등 Asset 없이 쓰는 경로 ----
    def raw_price(self, sym: str) -> float:
        rows = fetch_csv(
            "https://stooq.com/q/l/",
            params={"s": sym, "f": "sd2t2ohlcv", "h": "", "e": "csv"},
            timeout=self.timeout,
        )
        if not rows:
            raise FetchError(f"stooq: 빈 응답 ({sym})")
        close = rows[0].get("Close")
        if not close or close in ("N/D", "-"):
            raise FetchError(f"stooq: 가격 없음 ({sym})")
        return float(close)

    def _previous_close(self, sym: str) -> float | None:
        """일봉 CSV 에서 직전 거래일 종가. 실패해도 시세 자체는 유효하므로 None."""
        try:
            rows = fetch_csv(
                "https://stooq.com/q/d/l/", params={"s": sym, "i": "d"}, timeout=self.timeout
            )
        except FetchError:
            return None
        closes = [r.get("Close") for r in rows[-3:] if r.get("Close") not in (None, "", "N/D")]
        if len(closes) < 2:
            return None
        try:
            return float(closes[-2])
        except ValueError:
            return None
