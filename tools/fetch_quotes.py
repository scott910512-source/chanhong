"""깃허브 액션이 야후에서 시세를 받아 web/quotes.json 으로 떨궈놓는 스크립트.

폰 브라우저는 CORS 때문에 야후를 직접 못 부른다. 그래서 깃허브 액션이 대신 받아
앱과 '같은 주소'에 파일로 올려두면, 앱은 그냥 자기 사이트의 파일을 읽는 셈이라
CORS 문제도 없고 API 키도 필요 없다.

  python3 tools/fetch_quotes.py

읽는 파일 : web/watchlist.json  (받아올 종목 목록)
쓰는 파일 : web/quotes.json     (앱이 읽는 시세)
"""

from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from portfolio.fx import FxRates            # noqa: E402
from portfolio.models import Asset          # noqa: E402
from portfolio.quotes import QuoteService   # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
WATCHLIST = ROOT / "web" / "watchlist.json"
OUT = ROOT / "web" / "quotes.json"

# 티커 접미사로 국가/통화 추정 (앱의 guessAsset 과 같은 규칙)
SUFFIX_RULES = [
    ((".KS", ".KQ"), "KR", "KRW"),
    ((".VN",), "VN", "VND"),
    ((".T",), "JP", "JPY"),
    ((".HK",), "HK", "HKD"),
]


def asset_for(ticker: str) -> Asset:
    t = ticker.upper()
    for suffixes, country, currency in SUFFIX_RULES:
        if t.endswith(suffixes):
            return Asset(ticker=ticker, name=ticker, country=country, currency=currency)
    if t.isdigit() and len(t) == 6:  # 코드만 적었으면 코스피로 본다
        return Asset(ticker=f"{t}.KS", name=ticker, country="KR", currency="KRW")
    return Asset(ticker=ticker, name=ticker, country="US", currency="USD")


def main() -> int:
    if not WATCHLIST.exists():
        print(f"watchlist 가 없습니다: {WATCHLIST}")
        return 1
    conf = json.loads(WATCHLIST.read_text(encoding="utf-8"))
    tickers = [str(t).strip() for t in (conf.get("tickers") or []) if str(t).strip()]
    base = str(conf.get("base_currency", "KRW")).upper()
    if not tickers:
        print("watchlist 에 종목이 없습니다.")
        return 1

    assets = [asset_for(t) for t in tickers]
    print(f"{len(assets)}종목 수집 시작 (기준통화 {base})")

    # 액션은 매번 새로 받아야 하므로 캐시를 쓰지 않는다
    svc = QuoteService(ROOT / "data" / "cache" / "actions-quotes.json",
                       # 야후는 클라우드 IP 를 429 로 막는 일이 잦아서 네이버를 뒤에 받쳐둔다
                       order=["yahoo", "naver", "naver_global", "vietnam", "stooq"],
                       timeout=15, cache_ttl=0)
    book = svc.fetch(assets, base, refresh=True)
    for line in book.log:
        print(" ", line.strip())

    # 캐시로 폴백한 값(stale)은 절대 올리지 않는다. 옛날 가격을 실시간인 척
    # 배포하면 앱이 조용히 틀린 숫자를 보여주게 된다.
    quotes = {}
    skipped_stale = []
    for a in assets:
        q = book.get(a.ticker)
        if not q:
            continue
        if q.stale:
            skipped_stale.append(a.ticker)
            continue
        quotes[a.ticker] = {
            "price": q.price,
            "previousClose": q.previous_close,
            "currency": q.currency,
            "source": f"Yahoo 자동수집({q.source})" if q.source != "yahoo" else "Yahoo 자동수집",
            "asOf": q.as_of.isoformat() if q.as_of else None,
        }

    # 환율도 캐시에서 온 건 빼고 이번에 실제로 받은 것만 싣는다
    fresh_fx = {
        cur: rate for cur, rate in book.fx.rates.items()
        if not str(book.fx.sources.get(cur, "")).startswith("cache:")
    }

    payload = {
        "generatedAt": dt.datetime.now(dt.timezone.utc).astimezone().isoformat(),
        "baseCurrency": base,
        "quotes": quotes,
        "fx": {
            "rates": fresh_fx,
            "sources": {c: book.fx.sources.get(c, "?") for c in fresh_fx},
        },
    }

    if skipped_stale:
        print(f"\n캐시 폴백이라 제외: {', '.join(skipped_stale)}")
    if not quotes:
        print("실제로 받아온 시세가 없습니다. 기존 파일을 건드리지 않습니다.")
        return 1

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    missing = [t for t in tickers if t not in quotes]
    print(f"\n{len(quotes)}/{len(tickers)}종목 저장 -> {OUT}")
    if missing:
        print(f"실패: {', '.join(missing)}")
    print("환율:", {k: round(v, 4) for k, v in book.fx.rates.items()})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
