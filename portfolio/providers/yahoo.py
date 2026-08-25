"""Yahoo Finance - 키 없이 전 세계(미국/한국/베트남) 시세를 주는 1순위 공급자.

엔드포인트: /v8/finance/chart/{symbol}
심볼 규칙: 미국 AAPL / 한국 005930.KS(코스피) 000000.KQ(코스닥) / 베트남 FPT.VN
"""

from __future__ import annotations

import datetime as dt

from ..httpx import FetchError, fetch_json
from ..models import Asset, Quote
from .base import Provider

HOSTS = ("https://query1.finance.yahoo.com", "https://query2.finance.yahoo.com")


class YahooProvider(Provider):
    name = "yahoo"
    label = "Yahoo Finance"
    rate_limit_note = "키 불필요 / 과도한 호출 시 일시 차단될 수 있음"

    def get_quote(self, asset: Asset) -> Quote:
        sym = self.symbol(asset)
        last_err: Exception | None = None
        for host in HOSTS:
            try:
                data = fetch_json(
                    f"{host}/v8/finance/chart/{sym}",
                    params={"range": "5d", "interval": "1d"},
                    timeout=self.timeout,
                )
                return self._parse(asset, data)
            except FetchError as e:
                last_err = e
        raise FetchError(f"yahoo 실패: {sym} ({last_err})")

    def _parse(self, asset: Asset, data: dict) -> Quote:
        chart = (data or {}).get("chart") or {}
        if chart.get("error"):
            raise FetchError(f"yahoo error: {chart['error']}")
        results = chart.get("result") or []
        if not results:
            raise FetchError("yahoo: 빈 응답")
        meta = results[0].get("meta") or {}
        price = meta.get("regularMarketPrice")
        if price is None:
            raise FetchError("yahoo: 가격 없음")
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        ts = meta.get("regularMarketTime")
        as_of = (
            dt.datetime.fromtimestamp(ts, dt.timezone.utc).astimezone() if ts else None
        )
        return self._quote(
            asset,
            price,
            prev,
            currency=meta.get("currency") or asset.currency,
            as_of=as_of,
        )
