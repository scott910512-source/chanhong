"""시세 수집 오케스트레이터.

- settings.yaml 의 providers.order 순서대로 시도, 첫 성공 값을 사용
- 성공/실패를 모두 기록해서 리포트에 '어디서 받은 값인지' 표시
- 결과를 data/cache/quotes.json 에 저장 -> 네트워크가 막혀도 마지막 값으로 동작
"""

from __future__ import annotations

import concurrent.futures as cf
import datetime as dt
import json
from pathlib import Path

from . import providers as provider_registry
from .fx import FxRates
from .httpx import FetchError
from .models import Asset, Quote


class QuoteBook:
    def __init__(self, quotes: dict[str, Quote], log: list[str], fx: FxRates):
        self.quotes = quotes
        self.log = log
        self.fx = fx

    def get(self, ticker: str) -> Quote | None:
        return self.quotes.get(ticker)

    @property
    def sources(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for q in self.quotes.values():
            out[q.source] = out.get(q.source, 0) + 1
        return out

    @property
    def any_stale(self) -> bool:
        return any(q.stale for q in self.quotes.values())


class QuoteService:
    def __init__(self, cache_path: Path, order: list[str] | None = None,
                 timeout: float = 10.0, cache_ttl: int = 300, workers: int = 8):
        self.cache_path = Path(cache_path)
        self.order = order
        self.timeout = timeout
        self.cache_ttl = cache_ttl
        self.workers = workers
        self.providers = provider_registry.build(order, timeout=timeout)

    # ------------------------------------------------------------------
    def fetch(self, assets: list[Asset], base_currency: str = "KRW",
              offline: bool = False, refresh: bool = False) -> QuoteBook:
        log: list[str] = []
        cache = self._read_cache()
        cached_quotes = {
            t: Quote.from_dict(d) for t, d in (cache.get("quotes") or {}).items()
        }

        quotes: dict[str, Quote] = {}
        todo: list[Asset] = []

        for a in assets:
            cq = cached_quotes.get(a.ticker)
            if not refresh and cq and self._fresh(cq):
                quotes[a.ticker] = cq
                log.append(f"· {a.ticker}: 캐시 재사용 ({cq.source}, TTL {self.cache_ttl}s)")
            elif offline:
                if cq:
                    cq.stale = True
                    quotes[a.ticker] = cq
                    log.append(f"· {a.ticker}: 오프라인 - 마지막 캐시값 사용 ({cq.source})")
                else:
                    log.append(f"! {a.ticker}: 오프라인 & 캐시 없음 -> 시세 미확보")
            else:
                todo.append(a)

        if todo:
            if not self.providers:
                log.append("! 사용 가능한 시세 공급자가 없습니다 (providers.order 확인)")
            with cf.ThreadPoolExecutor(max_workers=self.workers) as ex:
                futures = {ex.submit(self._fetch_one, a): a for a in todo}
                for fut in cf.as_completed(futures):
                    asset = futures[fut]
                    quote, lines = fut.result()
                    log.extend(lines)
                    if quote:
                        quotes[asset.ticker] = quote
                    else:
                        fallback = cached_quotes.get(asset.ticker)
                        if fallback:
                            fallback.stale = True
                            quotes[asset.ticker] = fallback
                            log.append(
                                f"  -> {asset.ticker}: 전 공급자 실패, 캐시값으로 대체"
                                f" ({fallback.source}, {fallback.as_of})"
                            )

        fx = FxRates(base_currency, timeout=self.timeout)
        currencies = sorted({a.currency for a in assets})
        if not offline:
            fx.load(currencies)
        fx.apply_cached(cache.get("fx") or {})
        if offline:
            log.append("· 환율: 오프라인 - 캐시값 사용")
        for err in fx.errors:
            log.append(f"! 환율: {err}")
        missing_fx = [c for c in currencies if fx.rate(c) is None]
        if missing_fx:
            log.append(f"! 환율 미확보 통화: {', '.join(missing_fx)}")

        self._write_cache(quotes, fx)
        return QuoteBook(quotes, log, fx)

    # ------------------------------------------------------------------
    def _fetch_one(self, asset: Asset) -> tuple[Quote | None, list[str]]:
        lines: list[str] = []
        for p in self.providers:
            if not p.supports(asset):
                continue
            try:
                q = p.get_quote(asset)
            except FetchError as e:
                lines.append(f"  x {asset.ticker} @{p.name}: {e}")
                continue
            except Exception as e:  # 공급자 응답 포맷 변경 등
                lines.append(f"  x {asset.ticker} @{p.name}: 예상치 못한 오류 {e!r}")
                continue
            lines.append(f"· {asset.ticker}: {p.label} 에서 수신 ({q.price:,.4g} {q.currency})")
            return q, lines
        lines.append(f"! {asset.ticker}: 모든 공급자 실패")
        return None, lines

    def _fresh(self, q: Quote) -> bool:
        if not q.as_of:
            return False
        age = (dt.datetime.now(dt.timezone.utc) - q.as_of.astimezone(dt.timezone.utc))
        return age.total_seconds() < self.cache_ttl

    # ---- 캐시 I/O ----
    def _read_cache(self) -> dict:
        for path in (self.cache_path, self.cache_path.with_name("quotes.seed.json")):
            if path.exists():
                try:
                    return json.loads(path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
        return {}

    def _write_cache(self, quotes: dict[str, Quote], fx: FxRates) -> None:
        payload = {
            "saved_at": dt.datetime.now(dt.timezone.utc).astimezone().isoformat(),
            "quotes": {t: q.to_dict() for t, q in quotes.items()},
            "fx": fx.to_dict(),
        }
        try:
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
        except OSError:
            pass
