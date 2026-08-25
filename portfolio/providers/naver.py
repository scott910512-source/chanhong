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


class NaverGlobalProvider(Provider):
    """네이버 금융 해외주식. 야후가 클라우드 IP 를 429 로 막을 때의 대안.

    네이버는 종목코드에 거래소 접미사를 붙인다: 나스닥 .O / 뉴욕 .N / 아멕스 .A
    어느 거래소인지 모르므로 순서대로 시도한다.
    settings 의 symbols.naver_global 로 직접 지정할 수도 있다.
    """

    name = "naver_global"
    label = "네이버 해외주식"
    countries = {"US"}
    rate_limit_note = "키 불필요 / 미국 종목, 야후가 막힐 때의 대안"

    SUFFIXES = (".O", ".N", ".A")

    def candidates(self, asset: Asset) -> list[str]:
        override = asset.symbol_for(self.name)
        if override:
            return [override]
        base = asset.ticker.split(".")[0].upper().replace("-", "")
        return [f"{base}{s}" for s in self.SUFFIXES]

    def get_quote(self, asset: Asset) -> Quote:
        errors = []
        for sym in self.candidates(asset):
            try:
                return self._one(asset, sym)
            except FetchError as e:
                errors.append(f"{sym}: {e}")
        raise FetchError(f"naver_global 실패 ({asset.ticker}) - {' | '.join(errors)}")

    def _one(self, asset: Asset, sym: str) -> Quote:
        data = fetch_json(
            f"https://api.stock.naver.com/stock/{sym}/basic", timeout=self.timeout
        )
        if not isinstance(data, dict):
            raise FetchError("응답 형식이 예상과 다름")
        price = _num(data.get("closePrice"))
        if price is None:
            raise FetchError("가격 없음")
        delta = _num(data.get("compareToPreviousClosePrice"))
        prev = price - delta if delta is not None else None
        currency = ((data.get("currencyType") or {}).get("code")
                    if isinstance(data.get("currencyType"), dict) else None)
        return self._quote(asset, price, prev, currency=currency or asset.currency)
