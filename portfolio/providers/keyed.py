"""API 키가 필요한 공급자들 (환경변수로 키를 넣으면 자동 활성화).

  FINNHUB_API_KEY       https://finnhub.io           무료 60회/분, 미국 실시간
  TWELVE_DATA_API_KEY   https://twelvedata.com       무료 800회/일, 글로벌
  ALPHAVANTAGE_API_KEY  https://alphavantage.co      무료 25회/일, 글로벌(느림)
  MARKETSTACK_API_KEY   https://marketstack.com      무료 100회/월, 종가
"""

from __future__ import annotations

from ..httpx import FetchError, fetch_json
from ..models import Asset, Quote
from .base import Provider


class FinnhubProvider(Provider):
    name = "finnhub"
    label = "Finnhub"
    needs_key = True
    key_env = "FINNHUB_API_KEY"
    countries = {"US"}
    rate_limit_note = "무료 60회/분, 미국 실시간"

    def get_quote(self, asset: Asset) -> Quote:
        d = fetch_json(
            "https://finnhub.io/api/v1/quote",
            params={"symbol": self.symbol(asset), "token": self.api_key},
            timeout=self.timeout,
        )
        price = d.get("c")
        if not price:
            raise FetchError(f"finnhub: 가격 없음 ({self.symbol(asset)})")
        return self._quote(asset, price, d.get("pc"))


class TwelveDataProvider(Provider):
    name = "twelvedata"
    label = "Twelve Data"
    needs_key = True
    key_env = "TWELVE_DATA_API_KEY"
    rate_limit_note = "무료 800회/일, 글로벌(한국/베트남 일부 지원)"

    def get_quote(self, asset: Asset) -> Quote:
        d = fetch_json(
            "https://api.twelvedata.com/quote",
            params={"symbol": self.symbol(asset), "apikey": self.api_key},
            timeout=self.timeout,
        )
        if d.get("status") == "error" or "close" not in d:
            raise FetchError(f"twelvedata: {d.get('message', '가격 없음')}")
        return self._quote(
            asset, float(d["close"]), _f(d.get("previous_close")),
            currency=d.get("currency") or asset.currency,
        )


class AlphaVantageProvider(Provider):
    name = "alphavantage"
    label = "Alpha Vantage"
    needs_key = True
    key_env = "ALPHAVANTAGE_API_KEY"
    rate_limit_note = "무료 25회/일 - 종목 수가 적을 때만 권장"

    def get_quote(self, asset: Asset) -> Quote:
        d = fetch_json(
            "https://www.alphavantage.co/query",
            params={
                "function": "GLOBAL_QUOTE",
                "symbol": self.symbol(asset),
                "apikey": self.api_key,
            },
            timeout=self.timeout,
        )
        q = d.get("Global Quote") or {}
        price = _f(q.get("05. price"))
        if not price:
            raise FetchError(f"alphavantage: 가격 없음 / 한도 초과 ({d.get('Note') or ''})")
        return self._quote(asset, price, _f(q.get("08. previous close")))


class MarketstackProvider(Provider):
    name = "marketstack"
    label = "Marketstack"
    needs_key = True
    key_env = "MARKETSTACK_API_KEY"
    rate_limit_note = "무료 100회/월, 종가 기준"

    def get_quote(self, asset: Asset) -> Quote:
        d = fetch_json(
            "https://api.marketstack.com/v1/eod/latest",
            params={"access_key": self.api_key, "symbols": self.symbol(asset)},
            timeout=self.timeout,
        )
        rows = (d or {}).get("data") or []
        if not rows:
            raise FetchError("marketstack: 빈 응답")
        # eod/latest 는 전일 종가를 주지 않으므로 등락률은 비워둔다.
        return self._quote(asset, float(rows[0]["close"]))


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
