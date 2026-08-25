"""네이버 금융 - 한국 주식(KOSPI/KOSDAQ) 폴백 공급자. 키 불필요."""

from __future__ import annotations

from ..httpx import FetchError, fetch_json
from ..models import Asset, Quote
from .base import Provider


def _code(ticker: str) -> str:
    """005930.KS -> 005930"""
    return ticker.split(".")[0]


class NaverProvider(Provider):
    name = "naver"
    label = "네이버 금융"
    countries = {"KR"}
    rate_limit_note = "키 불필요 / 국내 종목 전용"

    def symbol(self, asset: Asset) -> str:
        return asset.symbol_for(self.name) or _code(asset.ticker)

    def get_quote(self, asset: Asset) -> Quote:
        code = self.symbol(asset)
        try:
            data = fetch_json(
                f"https://polling.finance.naver.com/api/realtime/domestic/stock/{code}",
                timeout=self.timeout,
            )
            items = (data.get("datas") or []) if isinstance(data, dict) else []
            if items:
                d = items[0]
                price = _num(d.get("closePrice"))
                prev = None
                if price is not None:
                    delta = _num(d.get("compareToPreviousClosePrice"))
                    if delta is not None:
                        prev = price - delta
                if price:
                    return self._quote(asset, price, prev, currency="KRW")
        except FetchError:
            pass

        # 폴백: m.stock.naver.com 종목 요약 API
        data = fetch_json(
            f"https://m.stock.naver.com/api/stock/{code}/basic", timeout=self.timeout
        )
        price = _num(data.get("closePrice"))
        if price is None:
            raise FetchError(f"naver: 가격 없음 ({code})")
        delta = _num(data.get("compareToPreviousClosePrice"))
        prev = price - delta if delta is not None else None
        return self._quote(asset, price, prev, currency="KRW")


def _num(v) -> float | None:
    if v is None:
        return None
    try:
        return float(str(v).replace(",", "").replace("+", ""))
    except ValueError:
        return None
