"""시세 공급자 공통 인터페이스."""

from __future__ import annotations

import datetime as dt
import os
from typing import Optional

from ..models import Asset, Quote


class Provider:
    """시세 공급자 베이스 클래스.

    name          : settings.yaml providers.order 에서 쓰는 식별자
    needs_key     : API 키가 필요한지
    key_env       : 키를 읽어올 환경변수 이름
    countries     : 지원 국가(None 이면 전 세계)
    """

    name = "base"
    label = "Base"
    needs_key = False
    key_env: Optional[str] = None
    countries: Optional[set[str]] = None
    rate_limit_note = ""

    def __init__(self, timeout: float = 10.0):
        self.timeout = timeout

    # ---- 공통 유틸 ----
    @property
    def api_key(self) -> Optional[str]:
        return os.environ.get(self.key_env) if self.key_env else None

    def available(self) -> bool:
        """설정상 이 공급자를 쓸 수 있는지."""
        return (not self.needs_key) or bool(self.api_key)

    def supports(self, asset: Asset) -> bool:
        if self.countries is None:
            return True
        return asset.country.upper() in self.countries

    def symbol(self, asset: Asset) -> str:
        """공급자별 심볼. settings.yaml 의 symbols 로 덮어쓸 수 있다."""
        return asset.symbol_for(self.name) or asset.ticker

    # ---- 구현 대상 ----
    def get_quote(self, asset: Asset) -> Quote:  # pragma: no cover - 인터페이스
        raise NotImplementedError

    # ---- 헬퍼 ----
    def _quote(self, asset: Asset, price: float, prev: Optional[float] = None,
               currency: Optional[str] = None, as_of: Optional[dt.datetime] = None) -> Quote:
        return Quote(
            ticker=asset.ticker,
            price=float(price),
            currency=(currency or asset.currency),
            previous_close=(float(prev) if prev else None),
            source=self.name,
            as_of=as_of or dt.datetime.now(dt.timezone.utc).astimezone(),
        )
