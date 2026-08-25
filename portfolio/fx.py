"""환율. 여러 무료 소스를 순서대로 시도하고 캐시한다.

  1) open.er-api.com   (키 불필요, 일 1회 갱신)
  2) frankfurter.app   (키 불필요, ECB 기준 - VND 미지원)
  3) exchangerate.host (키 불필요)
  4) Yahoo FX 페어     (USDKRW=X 형태, 실시간에 가장 근접)
  5) Stooq FX 페어     (usdkrw)
"""

from __future__ import annotations

import datetime as dt

from .httpx import FetchError, fetch_csv, fetch_json


class FxRates:
    """<종목통화> -> <기준통화> 환산 계수를 제공."""

    def __init__(self, base: str = "KRW", timeout: float = 10.0):
        self.base = base.upper()
        self.timeout = timeout
        self.rates: dict[str, float] = {self.base: 1.0}
        self.sources: dict[str, str] = {self.base: "base"}
        self.as_of: dt.datetime | None = None
        self.errors: list[str] = []

    # ---- 조회 ----
    def rate(self, currency: str) -> float | None:
        return self.rates.get(currency.upper())

    def convert(self, amount: float, currency: str) -> float | None:
        r = self.rate(currency)
        return None if r is None else amount * r

    def set_rate(self, currency: str, rate: float, source: str) -> None:
        self.rates[currency.upper()] = float(rate)
        self.sources[currency.upper()] = source

    # ---- 수집 ----
    def load(self, currencies: list[str], offline: bool = False) -> "FxRates":
        need = {c.upper() for c in currencies if c and c.upper() != self.base}
        need -= set(self.rates)
        if not need or offline:
            if need and offline:
                self.errors.append(f"오프라인: {', '.join(sorted(need))} 환율 미수집")
            return self

        for fetcher in (self._er_api, self._frankfurter, self._exchangerate_host):
            if not need:
                break
            try:
                got = fetcher(need)
            except FetchError as e:
                self.errors.append(str(e))
                continue
            need -= set(got)

        # 남은 통화는 페어 단위로 개별 조회
        for cur in sorted(need):
            for fetcher in (self._yahoo_pair, self._stooq_pair):
                try:
                    self.set_rate(cur, fetcher(cur), fetcher.__name__.strip("_"))
                    break
                except FetchError as e:
                    self.errors.append(str(e))

        self.as_of = dt.datetime.now(dt.timezone.utc).astimezone()
        return self

    # ---- 개별 소스 ----
    def _er_api(self, need: set[str]) -> set[str]:
        d = fetch_json(f"https://open.er-api.com/v6/latest/{self.base}", timeout=self.timeout)
        rates = (d or {}).get("rates") or {}
        return self._absorb(need, rates, "open.er-api.com")

    def _frankfurter(self, need: set[str]) -> set[str]:
        d = fetch_json(
            "https://api.frankfurter.app/latest",
            params={"from": self.base, "to": ",".join(sorted(need))},
            timeout=self.timeout,
        )
        return self._absorb(need, (d or {}).get("rates") or {}, "frankfurter.app")

    def _exchangerate_host(self, need: set[str]) -> set[str]:
        d = fetch_json(
            "https://api.exchangerate.host/latest",
            params={"base": self.base, "symbols": ",".join(sorted(need))},
            timeout=self.timeout,
        )
        return self._absorb(need, (d or {}).get("rates") or {}, "exchangerate.host")

    def _absorb(self, need: set[str], rates: dict, source: str) -> set[str]:
        """rates 는 '기준통화 1단위 = X 외화'. 우리가 필요한 건 그 역수."""
        got = set()
        for cur in list(need):
            v = rates.get(cur)
            if v:
                self.set_rate(cur, 1.0 / float(v), source)
                got.add(cur)
        return got

    def _yahoo_pair(self, cur: str) -> float:
        d = fetch_json(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{cur}{self.base}=X",
            params={"range": "5d", "interval": "1d"},
            timeout=self.timeout,
        )
        res = ((d or {}).get("chart") or {}).get("result") or []
        price = (res[0].get("meta") or {}).get("regularMarketPrice") if res else None
        if not price:
            raise FetchError(f"yahoo fx: {cur}{self.base} 실패")
        return float(price)

    def _stooq_pair(self, cur: str) -> float:
        rows = fetch_csv(
            "https://stooq.com/q/l/",
            params={"s": f"{cur}{self.base}".lower(), "f": "sd2t2ohlcv", "e": "csv"},
            timeout=self.timeout,
        )
        close = rows[0].get("Close") if rows else None
        if not close or close in ("N/D", "-"):
            raise FetchError(f"stooq fx: {cur}{self.base} 실패")
        return float(close)

    # ---- 캐시 직렬화 ----
    def to_dict(self) -> dict:
        return {
            "base": self.base,
            "rates": self.rates,
            "sources": self.sources,
            "as_of": self.as_of.isoformat() if self.as_of else None,
        }

    def apply_cached(self, d: dict) -> None:
        if not d or d.get("base") != self.base:
            return
        for cur, rate in (d.get("rates") or {}).items():
            if cur not in self.rates:
                self.set_rate(cur, rate, f"cache:{(d.get('sources') or {}).get(cur, '?')}")
