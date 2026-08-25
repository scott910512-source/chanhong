"""커맨드라인 진입점.

  python3 -m portfolio show            보유/비중/리밸런싱 안내 (기본)
  python3 -m portfolio show --refresh  캐시 무시하고 시세 새로 받기
  python3 -m portfolio show --offline  네트워크 없이 마지막 캐시로 계산
  python3 -m portfolio html            web/dashboard.html 생성
  python3 -m portfolio serve           웹앱(PWA)을 띄우기 - 같은 와이파이면 폰에서 접속
  python3 -m portfolio import <파일>   폰/엑셀에서 받은 거래내역을 표준 CSV 에 병합
  python3 -m portfolio export --json out.json --csv out.csv
  python3 -m portfolio providers       붙어 있는 시세 API 목록/상태
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import config, exporter, report
from .config import DEFAULT_CACHE, DEFAULT_OUT, DEFAULT_SETTINGS, DEFAULT_TRANSACTIONS
from .engine import build_portfolio
from .loader import append_transactions, load_transactions
from .quotes import QuoteService
from .rules import BypassRegistry, evaluate


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="portfolio", description="내 주식 자체 관리 시스템",
        formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__,
    )
    p.add_argument("command", nargs="?", default="show",
                   choices=["show", "html", "serve", "import", "export", "providers"])
    p.add_argument("file", nargs="?", help="import 할 파일 경로")
    p.add_argument("-s", "--settings", default=str(DEFAULT_SETTINGS), help="설정 파일")
    p.add_argument("-t", "--transactions", default=str(DEFAULT_TRANSACTIONS), help="거래내역 파일")
    p.add_argument("--cache", default=str(DEFAULT_CACHE), help="시세 캐시 파일")
    p.add_argument("--cash", type=float, default=None, help="예수금(기준통화). 비중 계산에 포함")
    p.add_argument("--refresh", action="store_true", help="캐시 무시하고 시세 재수집")
    p.add_argument("--offline", action="store_true", help="네트워크 사용 안 함(캐시만)")
    p.add_argument("--bypass", action="append", default=[], metavar="SPEC",
                   help="예외 추가. 예) --bypass TSLA --bypass country:VN=환전이슈")
    p.add_argument("--no-bypass", action="store_true", help="설정된 예외를 전부 무시하고 전수 점검")
    p.add_argument("--all", action="store_true", help="적정 판정 항목까지 전부 표시")
    p.add_argument("--json", metavar="PATH", help="결과 JSON 저장")
    p.add_argument("--csv", metavar="PATH", help="보유종목 CSV 저장")
    p.add_argument("-o", "--out", default=str(DEFAULT_OUT), help="html 출력 경로")
    p.add_argument("--port", type=int, default=8765, help="serve 포트")
    p.add_argument("--host", default="0.0.0.0", help="serve 바인드 주소")
    p.add_argument("-v", "--verbose", action="store_true", help="시세 수집 로그 전부 출력")
    p.add_argument("--no-color", action="store_true", help="색상 끄기")
    return p


def _prepare(args):
    settings = config.load_settings(args.settings)
    txs = load_transactions(args.transactions)
    svc = QuoteService(Path(args.cache), order=settings.provider_order,
                       timeout=settings.timeout, cache_ttl=settings.cache_ttl)
    assets = [settings.asset(t) for t in sorted({tx.ticker for tx in txs})]
    book = svc.fetch(assets, settings.base_currency,
                     offline=args.offline, refresh=args.refresh)
    cash = args.cash if args.cash is not None else float(settings.rules.get("cash", 0) or 0)
    pf = build_portfolio(txs, settings, book, cash=cash)
    bypass = BypassRegistry(settings, extra=args.bypass, disabled=args.no_bypass)
    signals = evaluate(pf, settings, bypass)
    return settings, txs, book, pf, signals, bypass


def cmd_show(args) -> int:
    settings, _txs, book, pf, signals, bypass = _prepare(args)
    print(report.render_fetch_log(book, args.verbose))
    print(report.render_summary(pf, book))
    print(report.render_positions(pf))
    for dim in ("country", "sector", "currency", "asset_class", "account"):
        if pf.breakdown(dim):
            out = report.render_breakdown(pf, dim, settings)
            if out:
                print(out)
    print(report.render_signals(signals, pf, show_all=args.all))
    print(report.render_plan(signals, pf))
    stale = [e for e in bypass.unused if e.key]
    if stale:
        print(report.c(
            "\n  · 이번에 걸리지 않은 예외 설정: "
            + ", ".join(f"{e.scope}:{e.key}" for e in stale), report.DIM))
    _side_exports(args, pf, signals, book)
    return 0


def cmd_html(args) -> int:
    from . import dashboard

    settings, _txs, book, pf, signals, _bp = _prepare(args)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(dashboard.render(pf, signals, settings, book), encoding="utf-8")
    print(f"대시보드 생성: {out}")
    _side_exports(args, pf, signals, book)
    return 0


def cmd_serve(args) -> int:
    """웹앱(PWA)을 띄운다. 앱은 브라우저 저장소로 독립 동작하지만,
    이 서버가 켜져 있으면 시세 수집을 서버가 대신 해준다(CORS 우회)."""
    from .server import AppContext, serve

    ctx = AppContext(Path(args.settings), Path(args.transactions), Path(args.cache))
    serve(ctx, host=args.host, port=args.port)
    return 0


def cmd_import(args) -> int:
    if not args.file:
        print("가져올 파일 경로를 지정하세요. 예) python3 -m portfolio import ~/Downloads/내역.csv",
              file=sys.stderr)
        return 2
    txs = load_transactions(args.file)
    added = append_transactions(args.transactions, txs)
    print(f"{args.file} 에서 {len(txs)}건 읽음 -> {added}건 추가 "
          f"(중복 {len(txs) - added}건 건너뜀) -> {args.transactions}")
    unknown = sorted({t.ticker for t in txs} - set(config.load_settings(args.settings).assets))
    if unknown:
        print("! settings.yaml 의 assets 에 없는 종목: " + ", ".join(unknown))
        print("  국가/통화/섹터를 등록해야 국가별 비중과 환산이 정확해집니다.")
    return 0


def cmd_export(args) -> int:
    _settings, _txs, book, pf, signals, _bp = _prepare(args)
    if not args.json and not args.csv:
        args.json = "portfolio.json"
    _side_exports(args, pf, signals, book)
    return 0


def cmd_providers(args) -> int:
    from . import providers as reg

    settings = config.load_settings(args.settings)
    order = settings.provider_order or reg.DEFAULT_ORDER
    rows = []
    for name in order:
        cls = reg.ALL_PROVIDERS.get(name)
        if not cls:
            rows.append([name, "?", "정의 없음", ""])
            continue
        inst = cls()
        if not inst.needs_key:
            state = "사용 가능"
        elif inst.api_key:
            state = "사용 가능 (키 감지)"
        else:
            state = f"대기 - {inst.key_env} 미설정"
        scope = "전 세계" if cls.countries is None else "/".join(sorted(cls.countries))
        rows.append([name, cls.label, state, f"{scope} · {cls.rate_limit_note}"])
    print(report.table(["id", "이름", "상태", "범위/비고"], rows,
                       ["left", "left", "left", "left"]))
    print("\n키가 필요한 공급자는 환경변수로 넣으면 자동으로 활성화됩니다:")
    print("  export FINNHUB_API_KEY=xxx  TWELVE_DATA_API_KEY=xxx  ALPHAVANTAGE_API_KEY=xxx")
    return 0


def _side_exports(args, pf, signals, book) -> None:
    if args.json:
        print(f"JSON 저장: {exporter.write_json(args.json, pf, signals, book)}")
    if args.csv:
        print(f"CSV 저장: {exporter.write_csv(args.csv, pf)}")


COMMANDS = {
    "show": cmd_show, "html": cmd_html, "serve": cmd_serve,
    "import": cmd_import, "export": cmd_export, "providers": cmd_providers,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    report.use_color(not args.no_color and sys.stdout.isatty())
    try:
        return COMMANDS[args.command](args)
    except (config.ConfigError, ValueError) as e:
        print(f"오류: {e}", file=sys.stderr)
        return 1
    except FileNotFoundError as e:
        print(f"파일을 찾을 수 없습니다: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
