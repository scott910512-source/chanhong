"""베트남 주식(HOSE/HNX/UPCOM) 시세. TCBS -> VNDirect 순으로 시도. 키 불필요.

주의: 베트남 시세 API 는 보통 '천 VND' 단위로 값을 준다(FPT 120.5 = 120,500 VND).
실제 VND 최저 호가가 1,000 VND 이상이므로 1000 미만 값이면 x1000 으로 환산한다.
"""

from __future__ import annotations

from ..httpx import FetchError, fetch_json
from ..models import Asset, Quote
from .base import Provider

THOUSAND_UNIT_CUTOFF = 1000.0


def _to_vnd(value: float) -> float:
    return value * 1000.0 if 0 < value < THOUSAND_UNIT_CUTOFF else value


class VietnamProvider(Provider):
    name = "vietnam"
    label = "TCBS / VNDirect (베트남)"
    countries = {"VN"}
    rate_limit_note = "키 불필요 / 베트남 종목 전용, 지연 시세일 수 있음"

    def symbol(self, asset: Asset) -> str:
        return asset.symbol_for(self.name) or asset.ticker.split(".")[0]

    def get_quote(self, asset: Asset) -> Quote:
        code = self.symbol(asset)
        errors = []
        for fn in (self._tcbs, self._vndirect):
            try:
                return fn(asset, code)
            except FetchError as e:
                errors.append(str(e))
        raise FetchError(f"vietnam 실패 ({code}): {' | '.join(errors)}")

    def _tcbs(self, asset: Asset, code: str) -> Quote:
        data = fetch_json(
            "https://apipubaws.tcbs.com.vn/stock-insight/v1/stock/second-tc-price",
            params={"tickers": code},
            timeout=self.timeout,
        )
        rows = (data or {}).get("data") or []
        if not rows:
            raise FetchError("tcbs: 빈 응답")
        row = rows[0]
        price = row.get("cp") or row.get("mp")  # close price / matched price
        if not price:
            raise FetchError("tcbs: 가격 없음")
        prev = row.get("rp") or row.get("refPrice")  # reference price = 전일 종가
        return self._quote(
            asset,
            _to_vnd(float(price)),
            _to_vnd(float(prev)) if prev else None,
            currency="VND",
        )

    def _vndirect(self, asset: Asset, code: str) -> Quote:
        data = fetch_json(
            "https://finfo-api.vndirect.com.vn/v4/stock_prices",
            params={"sort": "date:desc", "q": f"code:{code}", "size": "2"},
            timeout=self.timeout,
        )
        rows = (data or {}).get("data") or []
        if not rows:
            raise FetchError("vndirect: 빈 응답")
        cur = rows[0]
        price = cur.get("close") or cur.get("adClose")
        if not price:
            raise FetchError("vndirect: 가격 없음")
        prev = cur.get("basicPrice") or (rows[1].get("close") if len(rows) > 1 else None)
        return self._quote(
            asset,
            _to_vnd(float(price)),
            _to_vnd(float(prev)) if prev else None,
            currency="VND",
        )
