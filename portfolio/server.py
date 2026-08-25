"""PWA 웹앱을 서빙하고 JSON API 를 제공하는 로컬 서버.

브라우저에서 직접 Yahoo/네이버를 부르면 CORS 에 막히기 때문에,
PC 에서 이 서버를 켜두면 시세 수집을 서버가 대신 해준다.
서버가 꺼져 있어도 웹앱은 브라우저 저장소만으로 동작한다(오프라인 모드).

  python3 -m portfolio serve            # http://localhost:8765
  python3 -m portfolio serve --port 80  # 폰에서 접속하려면 PC 방화벽 허용 필요

API
  GET  /api/state              설정 + 거래내역 + 시세 + 계산결과
  GET  /api/quotes?refresh=1   시세만 다시 받기
  POST /api/transactions       {"transactions":[...]} 추가 (중복 자동 제거)
  POST /api/transactions/delete{"ids":[...]} 삭제
  PUT  /api/settings           앱에서 바꾼 설정을 data/settings.overrides.json 에 저장
"""

from __future__ import annotations

import datetime as dt
import json
import re
import socket
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

from . import config, exporter
from .engine import build_portfolio
from .loader import (
    LoaderError,
    append_transactions,
    delete_transactions,
    load_transactions,
)
from .models import Transaction
from .quotes import QuoteService
from .rules import BypassRegistry, evaluate

WEB_DIR = config.ROOT / "web"
MAX_BODY = 4 * 1024 * 1024  # 4MB


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status
        self.message = message


class AppContext:
    """설정/거래내역 경로를 들고 있으면서 요청마다 최신 상태를 계산한다."""

    def __init__(self, settings_path: Path, transactions_path: Path, cache_path: Path):
        self.settings_path = Path(settings_path)
        self.transactions_path = Path(transactions_path)
        self.cache_path = Path(cache_path)
        self.lock = threading.Lock()

    # ---- 읽기 ----
    def settings(self):
        return config.load_settings(self.settings_path)

    def transactions(self) -> list[Transaction]:
        if not self.transactions_path.exists():
            return []
        try:
            return load_transactions(self.transactions_path)
        except LoaderError:
            return []

    def quote_service(self, settings) -> QuoteService:
        return QuoteService(self.cache_path, order=settings.provider_order,
                            timeout=settings.timeout, cache_ttl=settings.cache_ttl)

    def state(self, refresh: bool = False, offline: bool = False) -> dict:
        settings = self.settings()
        txs = self.transactions()
        tickers = sorted({t.ticker for t in txs}) or list(settings.assets)
        assets = [settings.asset(t) for t in tickers]
        book = self.quote_service(settings).fetch(
            assets, settings.base_currency, offline=offline, refresh=refresh
        )
        cash = float(settings.rules.get("cash", 0) or 0)
        pf = build_portfolio(txs, settings, book, cash=cash)
        signals = evaluate(pf, settings, BypassRegistry(settings))

        result = exporter.to_dict(pf, signals, book)
        result["settings"] = settings.raw
        result["transactions"] = [_tx_dict(t) for t in txs]
        result["quotes"] = {t: q.to_dict() for t, q in book.quotes.items()}
        result["fetch_log"] = book.log
        result["server"] = {
            "transactions_path": str(self.transactions_path),
            "settings_path": str(self.settings_path),
            "offline": offline,
        }
        return result

    # ---- 쓰기 ----
    def add_transactions(self, rows: list[dict]) -> dict:
        txs = [_tx_from_dict(r) for r in rows]
        with self.lock:
            added = append_transactions(self.transactions_path, txs)
        return {"added": added, "skipped": len(txs) - added, "total": len(self.transactions())}

    def remove_transactions(self, ids: list[str]) -> dict:
        with self.lock:
            removed = delete_transactions(self.transactions_path, ids)
        return {"removed": removed, "total": len(self.transactions())}

    def replace_transactions(self, rows: list[dict]) -> dict:
        from .loader import write_transactions

        txs = [_tx_from_dict(r) for r in rows]
        with self.lock:
            write_transactions(self.transactions_path, txs)
        return {"total": len(txs)}

    def save_settings(self, payload: dict) -> dict:
        if not isinstance(payload, dict):
            raise ApiError("설정은 객체여야 합니다")
        path = config.overrides_path(self.settings_path)
        with self.lock:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2),
                            encoding="utf-8")
        return {"saved": str(path)}


def _tx_dict(t: Transaction) -> dict:
    return {
        "id": t.ensure_id(),
        "date": t.date.isoformat(),
        "ticker": t.ticker,
        "side": t.side,
        "quantity": t.quantity,
        "price": t.price,
        "fee": t.fee,
        "account": t.account,
        "note": t.note,
    }


def _tx_from_dict(d: dict) -> Transaction:
    if not isinstance(d, dict):
        raise ApiError("거래는 객체여야 합니다")
    try:
        ticker = str(d["ticker"]).strip()
        qty = abs(float(d["quantity"]))
        price = float(d["price"])
        date = dt.date.fromisoformat(str(d["date"])[:10])
    except (KeyError, TypeError, ValueError) as e:
        raise ApiError(f"거래 항목이 잘못됐습니다: {e}") from e
    if not ticker:
        raise ApiError("종목이 비어 있습니다")
    side = str(d.get("side", "BUY")).upper()
    if side not in ("BUY", "SELL"):
        raise ApiError(f"매매구분이 잘못됐습니다: {side}")
    tx = Transaction(
        date=date, ticker=ticker, side=side, quantity=qty, price=price,
        fee=float(d.get("fee") or 0), account=str(d.get("account") or "기본"),
        note=str(d.get("note") or ""), id=str(d.get("id") or ""),
    )
    tx.ensure_id()
    return tx


class Handler(SimpleHTTPRequestHandler):
    ctx: AppContext = None  # partial 로 주입

    def __init__(self, *args, ctx: AppContext = None, **kwargs):
        self.ctx = ctx
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    # ---- 로깅 조용히 ----
    def log_message(self, fmt, *args):
        if self.path.startswith("/api/"):
            print(f"  {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")

    # ---- 라우팅 ----
    def do_GET(self):
        if self.path.startswith("/api/"):
            return self._api()
        if self.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        return self._api()

    def do_PUT(self):
        return self._api()

    def do_OPTIONS(self):
        self._send(204, None)

    def _api(self):
        try:
            payload = self._dispatch()
        except ApiError as e:
            return self._send(e.status, {"error": e.message})
        except Exception as e:  # 서버가 죽지 않게
            import traceback

            traceback.print_exc()
            return self._send(500, {"error": f"{type(e).__name__}: {e}"})
        self._send(200, payload)

    def _dispatch(self):
        path = self.path.split("?")[0].rstrip("/") or "/"
        query = dict(
            re.findall(r"([^&=?]+)=([^&]*)", self.path.split("?", 1)[1])
            if "?" in self.path else []
        )
        if not path.startswith("/api"):
            raise ApiError("알 수 없는 경로", 404)

        if self.command == "GET" and path == "/api/state":
            return self.ctx.state(refresh=query.get("refresh") == "1",
                                  offline=query.get("offline") == "1")
        if self.command == "GET" and path == "/api/quotes":
            state = self.ctx.state(refresh=query.get("refresh") == "1")
            return {"quotes": state["quotes"], "fx": state["fx"],
                    "quote_sources": state["quote_sources"],
                    "fetch_log": state["fetch_log"]}
        if self.command == "GET" and path == "/api/ping":
            return {"ok": True, "app": "portfolio", "time": dt.datetime.now().isoformat()}

        if self.command == "POST" and path == "/api/transactions":
            body = self._body()
            return self.ctx.add_transactions(body.get("transactions") or [])
        if self.command == "POST" and path == "/api/transactions/delete":
            return self.ctx.remove_transactions(self._body().get("ids") or [])
        if self.command == "POST" and path == "/api/transactions/replace":
            return self.ctx.replace_transactions(self._body().get("transactions") or [])
        if self.command == "PUT" and path == "/api/settings":
            return self.ctx.save_settings(self._body().get("settings") or {})
        raise ApiError(f"지원하지 않는 요청: {self.command} {path}", 404)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ApiError("본문이 너무 큽니다", 413)
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError) as e:
            raise ApiError(f"JSON 파싱 실패: {e}") from e

    def _send(self, status: int, payload):
        body = b"" if payload is None else json.dumps(
            payload, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        if payload is not None:
            self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        if body:
            self.wfile.write(body)

    def end_headers(self):
        # 서비스워커가 갱신을 못 받는 사고를 막기 위해 정적파일도 재검증시킨다
        if not self.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()


def local_ips() -> list[str]:
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))  # 실제로 패킷을 보내지는 않는다
        ips.add(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                ips.add(ip)
    except OSError:
        pass
    return sorted(ips)


def serve(ctx: AppContext, host: str = "0.0.0.0", port: int = 8765) -> None:
    handler = partial(Handler, ctx=ctx)
    ThreadingHTTPServer.allow_reuse_address = True
    with ThreadingHTTPServer((host, port), handler) as httpd:
        print(f"\n  내 주식 관리 앱이 떴습니다")
        print(f"  이 PC        : http://localhost:{port}")
        for ip in local_ips():
            print(f"  같은 와이파이: http://{ip}:{port}   <- 폰 브라우저에서 열고 "
                  f"'홈 화면에 추가'")
        print(f"\n  거래내역 파일: {ctx.transactions_path}")
        print("  Ctrl+C 로 종료\n")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n종료")
