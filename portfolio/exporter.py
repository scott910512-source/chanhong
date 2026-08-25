"""계산 결과를 JSON/CSV 로 내보내기 (앱·차트·구글시트 연동용)."""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
from pathlib import Path

from .engine import Portfolio
from .models import Signal
from .quotes import QuoteBook
from .rules import consolidate


def to_dict(pf: Portfolio, signals: list[Signal], book: QuoteBook) -> dict:
    return {
        "generated_at": dt.datetime.now().astimezone().isoformat(),
        "base_currency": pf.base_currency,
        "summary": {
            "total_value": pf.total_value,
            "total_cost": pf.total_cost,
            "unrealized_pl": pf.unrealized_pl,
            "return_pct": pf.return_pct,
            "day_pl": pf.day_pl,
            "realized_pl": pf.realized_pl,
            "cash": pf.cash,
            "holdings": len(pf.positions),
            "hhi": pf.hhi,
            "effective_holdings": pf.effective_holdings,
            "top3_concentration": pf.top_concentration,
            "missing_prices": pf.missing_prices,
            "stale_quotes": book.any_stale,
        },
        "fx": book.fx.to_dict(),
        "quote_sources": book.sources,
        "positions": [
            {
                "ticker": p.asset.ticker,
                "name": p.asset.name,
                "country": p.asset.country,
                "currency": p.asset.currency,
                "sector": p.asset.sector,
                "asset_class": p.asset.asset_class,
                "tags": p.asset.tags,
                "accounts": sorted(p.accounts),
                "quantity": p.quantity,
                "avg_price": p.avg_price_local,
                "price": p.price_local,
                "day_change_pct": p.quote.day_change_pct if p.quote else None,
                "fx_rate": p.fx_rate,
                "cost_basis_base": p.cost_basis_base,
                "market_value_base": p.market_value_base,
                "unrealized_pl_base": p.unrealized_pl_base,
                "realized_pl_local": p.realized_pl_local,
                "return_pct": p.return_pct,
                "weight": p.weight,
                "quote_source": p.quote.source if p.quote else None,
                "quote_as_of": (p.quote.as_of.isoformat() if p.quote and p.quote.as_of else None),
                "quote_stale": p.quote.stale if p.quote else None,
                "first_buy": p.first_buy.isoformat() if p.first_buy else None,
            }
            for p in pf.positions
        ],
        "breakdowns": {
            dim: [
                {
                    "key": b.key, "label": b.label, "market_value": b.market_value,
                    "cost_basis": b.cost_basis, "weight": b.weight,
                    "unrealized_pl": b.unrealized_pl, "return_pct": b.return_pct,
                    "tickers": b.tickers,
                }
                for b in buckets
            ]
            for dim, buckets in pf.breakdowns.items()
        },
        "signals": [
            {
                "dimension": s.dimension, "key": s.key, "label": s.label,
                "action": s.action, "status": s.status,
                "current_weight": s.current_weight, "target_weight": s.target_weight,
                "min_weight": s.min_weight, "max_weight": s.max_weight,
                "gap_pp": s.gap_pp, "amount_base": s.amount_base, "shares": s.shares,
                "reason": s.reason, "candidates": s.candidates,
            }
            for s in signals
        ],
        "plan": [
            {
                "ticker": i.ticker, "label": i.label, "action": i.action,
                "amount_base": i.amount_base, "shares": i.shares,
                "reasons": i.reasons, "netted": i.netted,
            }
            for i in consolidate(signals, pf)
        ],
    }


def write_json(path: Path | str, pf: Portfolio, signals: list[Signal],
               book: QuoteBook) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(to_dict(pf, signals, book), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return path


def positions_csv(pf: Portfolio) -> str:
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(["ticker", "name", "country", "currency", "sector", "quantity",
                "avg_price", "price", "market_value_base", "cost_basis_base",
                "unrealized_pl_base", "return_pct", "weight", "source"])
    for p in pf.positions:
        w.writerow([
            p.asset.ticker, p.asset.name, p.asset.country, p.asset.currency,
            p.asset.sector, f"{p.quantity:g}", f"{p.avg_price_local:.4f}",
            (f"{p.price_local:.4f}" if p.price_local is not None else ""),
            (f"{p.market_value_base:.2f}" if p.market_value_base is not None else ""),
            f"{p.cost_basis_base:.2f}",
            (f"{p.unrealized_pl_base:.2f}" if p.unrealized_pl_base is not None else ""),
            (f"{p.return_pct:.4f}" if p.return_pct is not None else ""),
            f"{p.weight:.4f}", (p.quote.source if p.quote else ""),
        ])
    return buf.getvalue()


def write_csv(path: Path | str, pf: Portfolio) -> Path:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(positions_csv(pf), encoding="utf-8")
    return path
