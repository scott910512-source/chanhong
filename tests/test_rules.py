"""리밸런싱 판정 / 예외(bypass) / 주문서 합산 검증."""

import datetime as dt
import unittest

from portfolio.config import BypassEntry, Settings, TargetGroup, TargetItem
from portfolio.engine import build_portfolio
from portfolio.models import Asset
from portfolio.rules import BypassRegistry, consolidate, evaluate
from tests.test_engine import make_book, tx


def base_settings():
    s = Settings(base_currency="KRW")
    s.assets["AAPL"] = Asset("AAPL", "애플", "US", "USD", sector="IT")
    s.assets["005930.KS"] = Asset("005930.KS", "삼성전자", "KR", "KRW", sector="반도체")
    return s


def make_pf(settings):
    # AAPL 1,950,000 (70.9%) / 삼성 800,000 (29.1%)
    txs = [tx("2024-01-01", "AAPL", "BUY", 10, 100),
           tx("2024-01-01", "005930.KS", "BUY", 10, 70000)]
    book = make_book(
        {"AAPL": (150.0, 140.0, "USD"), "005930.KS": (80000.0, 79000.0, "KRW")},
        {"USD": 1300.0},
    )
    return build_portfolio(txs, settings, book)


def country_targets(us=50.0, kr=50.0, tolerance=5.0):
    g = TargetGroup("country", tolerance=tolerance)
    g.items = {"US": TargetItem("US", target=us), "KR": TargetItem("KR", target=kr)}
    return {"country": g}


class TestSignals(unittest.TestCase):
    def test_over_target_produces_sell(self):
        s = base_settings()
        s.targets = country_targets()
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s) if x.dimension == "country" and x.key == "US")
        self.assertEqual(sig.action, "SELL")
        self.assertEqual(sig.status, "ACTIVE")
        # 70.9% -> 50% : 총자산의 20.9%
        self.assertAlmostEqual(sig.amount_base, (sig.current_weight - 50) / 100 * pf.total_value)

    def test_under_target_produces_buy(self):
        s = base_settings()
        s.targets = country_targets()
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s) if x.dimension == "country" and x.key == "KR")
        self.assertEqual(sig.action, "BUY")
        self.assertEqual(sig.candidate_tickers, ["005930.KS"])

    def test_inside_band_is_ok(self):
        s = base_settings()
        s.targets = country_targets(us=70.0, kr=30.0, tolerance=5.0)
        pf = make_pf(s)
        for sig in evaluate(pf, s):
            if sig.dimension == "country":
                self.assertEqual(sig.action, "HOLD")
                self.assertEqual(sig.status, "OK")

    def test_item_tolerance_overrides_group(self):
        s = base_settings()
        s.targets = country_targets(us=70.0, kr=30.0, tolerance=5.0)
        s.targets["country"].items["US"].tolerance = 0.5  # 70.9% 는 밴드 밖
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s) if x.key == "US")
        self.assertEqual(sig.action, "SELL")

    def test_explicit_min_max_wins(self):
        s = base_settings()
        s.targets = country_targets(us=50.0, kr=50.0, tolerance=1.0)
        s.targets["country"].items["US"].max = 80.0
        s.targets["country"].items["US"].min = 10.0
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s) if x.key == "US")
        self.assertEqual(sig.action, "HOLD")

    def test_max_position_weight_rule(self):
        s = base_settings()
        s.rules = {"max_position_weight": 40}
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s) if x.dimension == "rule" and x.key == "AAPL")
        self.assertEqual(sig.action, "SELL")
        self.assertIsNotNone(sig.shares)

    def test_take_profit_rule(self):
        s = base_settings()
        s.rules = {"take_profit_pct": 40}  # AAPL +50%
        pf = make_pf(s)
        sigs = [x for x in evaluate(pf, s) if x.dimension == "rule" and x.key == "AAPL"]
        self.assertTrue(any("목표 수익률" in x.reason for x in sigs))

    def test_min_trade_amount_mutes_small_signals(self):
        s = base_settings()
        s.targets = country_targets(us=70.0, kr=30.0, tolerance=0.1)
        s.rules = {"min_trade_amount": 10_000_000}
        pf = make_pf(s)
        for sig in evaluate(pf, s):
            if sig.dimension == "country":
                self.assertEqual(sig.status, "MUTED")

    def test_shares_never_exceed_holding_on_sell(self):
        s = base_settings()
        s.targets = {"ticker": TargetGroup("ticker", tolerance=1.0,
                                           items={"AAPL": TargetItem("AAPL", target=0.0)})}
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s) if x.dimension == "ticker")
        self.assertLessEqual(sig.shares, 10.0)


class TestBypass(unittest.TestCase):
    def _settings_with_bypass(self, **kw):
        s = base_settings()
        s.targets = country_targets()
        s.bypass_entries = [BypassEntry(**kw)]
        return s

    def test_ticker_bypass_disables_rule_signal(self):
        s = self._settings_with_bypass(scope="ticker", key="AAPL", reason="장기보유")
        s.rules = {"max_position_weight": 40}
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s, BypassRegistry(s))
                   if x.dimension == "rule" and x.key == "AAPL")
        self.assertEqual(sig.status, "BYPASSED")
        self.assertIn("장기보유", sig.reason)

    def test_country_bypass(self):
        s = self._settings_with_bypass(scope="country", key="US", reason="환전 이슈")
        pf = make_pf(s)
        sig = next(x for x in evaluate(pf, s, BypassRegistry(s)) if x.key == "US")
        self.assertEqual(sig.status, "BYPASSED")

    def test_expired_bypass_reactivates_signal(self):
        s = self._settings_with_bypass(scope="country", key="US", reason="옛날 사유",
                                       until="2020-01-01")
        pf = make_pf(s)
        reg = BypassRegistry(s, today=dt.date(2026, 1, 1))
        sig = next(x for x in evaluate(pf, s, reg) if x.key == "US")
        self.assertEqual(sig.status, "ACTIVE")

    def test_no_bypass_flag_overrides_everything(self):
        s = self._settings_with_bypass(scope="all", key="*", reason="전부 무시")
        pf = make_pf(s)
        reg = BypassRegistry(s, disabled=True)
        sig = next(x for x in evaluate(pf, s, reg) if x.key == "US")
        self.assertEqual(sig.status, "ACTIVE")

    def test_cli_spec_parsing(self):
        s = base_settings()
        s.targets = country_targets()
        pf = make_pf(s)
        reg = BypassRegistry(s, extra=["country:US=수동 예외"])
        sig = next(x for x in evaluate(pf, s, reg) if x.key == "US")
        self.assertEqual(sig.status, "BYPASSED")
        self.assertIn("수동 예외", sig.reason)

    def test_bare_ticker_spec_defaults_to_ticker_scope(self):
        s = base_settings()
        s.rules = {"max_position_weight": 40}
        pf = make_pf(s)
        reg = BypassRegistry(s, extra=["AAPL"])
        sig = next(x for x in evaluate(pf, s, reg) if x.dimension == "rule")
        self.assertEqual(sig.status, "BYPASSED")

    def test_unused_bypass_is_reported(self):
        s = self._settings_with_bypass(scope="ticker", key="NOPE", reason="오타")
        pf = make_pf(s)
        reg = BypassRegistry(s)
        evaluate(pf, s, reg)
        self.assertEqual([e.key for e in reg.unused], ["NOPE"])


class TestConsolidate(unittest.TestCase):
    def test_overlapping_sells_are_not_summed(self):
        s = base_settings()
        # 종목 목표 + 섹터 목표 + 비중상한이 전부 AAPL 매도를 가리킴
        s.targets = {
            "ticker": TargetGroup("ticker", 1.0, items={"AAPL": TargetItem("AAPL", target=50.0)}),
            "sector": TargetGroup("sector", 1.0, items={"IT": TargetItem("IT", target=50.0)}),
        }
        s.rules = {"max_position_weight": 55}
        pf = make_pf(s)
        signals = evaluate(pf, s)
        plan = consolidate(signals, pf)
        aapl = [i for i in plan if i.ticker == "AAPL"]
        self.assertEqual(len(aapl), 1)
        biggest = max(x.amount_base for x in signals
                      if x.is_actionable and x.candidate_tickers[:1] == ["AAPL"])
        self.assertAlmostEqual(aapl[0].amount_base, biggest)
        self.assertGreaterEqual(len(aapl[0].reasons), 2)

    def test_conflicting_signals_are_netted(self):
        s = base_settings()
        s.targets = {
            "ticker": TargetGroup("ticker", 1.0,
                                  items={"AAPL": TargetItem("AAPL", target=60.0)}),
            "sector": TargetGroup("sector", 1.0, items={"IT": TargetItem("IT", target=80.0)}),
        }
        pf = make_pf(s)
        plan = consolidate(evaluate(pf, s), pf)
        aapl = next(i for i in plan if i.ticker == "AAPL")
        self.assertTrue(aapl.netted)

    def test_bypassed_signals_never_enter_the_plan(self):
        s = base_settings()
        s.targets = country_targets()
        s.bypass_entries = [BypassEntry(scope="all", key="*", reason="전면 중지")]
        pf = make_pf(s)
        self.assertEqual(consolidate(evaluate(pf, s, BypassRegistry(s)), pf), [])


if __name__ == "__main__":
    unittest.main()
