"""평단/손익/비중 계산 검증."""

import datetime as dt
import unittest

from portfolio.config import Settings
from portfolio.engine import build_portfolio, build_positions
from portfolio.fx import FxRates
from portfolio.models import Asset, Quote, Transaction
from portfolio.quotes import QuoteBook


def tx(date, ticker, side, qty, price, fee=0.0, account="기본"):
    return Transaction(dt.date.fromisoformat(date), ticker, side, qty, price, fee, account)


def make_settings():
    s = Settings(base_currency="KRW")
    s.assets["AAPL"] = Asset("AAPL", "애플", "US", "USD", sector="IT")
    s.assets["005930.KS"] = Asset("005930.KS", "삼성전자", "KR", "KRW", sector="반도체")
    return s


def make_book(prices, rates):
    fx = FxRates("KRW")
    for cur, rate in rates.items():
        fx.set_rate(cur, rate, "test")
    quotes = {
        t: Quote(t, p, cur, previous_close=prev, source="test")
        for t, (p, prev, cur) in prices.items()
    }
    return QuoteBook(quotes, [], fx)


class TestPositions(unittest.TestCase):
    def test_average_cost_includes_fees(self):
        txs = [tx("2024-01-01", "AAPL", "BUY", 10, 100, fee=10),
               tx("2024-02-01", "AAPL", "BUY", 10, 200, fee=10)]
        pos = build_positions(txs, make_settings())[0]
        self.assertEqual(pos.quantity, 20)
        self.assertEqual(pos.cost_basis_local, 3020)
        self.assertEqual(pos.avg_price_local, 151.0)

    def test_sell_keeps_average_and_books_realized(self):
        txs = [tx("2024-01-01", "AAPL", "BUY", 10, 100),
               tx("2024-03-01", "AAPL", "SELL", 4, 150, fee=1)]
        pos = build_positions(txs, make_settings())[0]
        self.assertEqual(pos.quantity, 6)
        self.assertEqual(pos.avg_price_local, 100.0)  # 매도해도 평단은 그대로
        self.assertAlmostEqual(pos.realized_pl_local, 4 * 50 - 1)

    def test_full_sell_drops_position(self):
        txs = [tx("2024-01-01", "AAPL", "BUY", 5, 100),
               tx("2024-03-01", "AAPL", "SELL", 5, 120)]
        self.assertEqual(build_positions(txs, make_settings()), [])

    def test_oversell_raises(self):
        txs = [tx("2024-01-01", "AAPL", "BUY", 5, 100),
               tx("2024-03-01", "AAPL", "SELL", 6, 120)]
        with self.assertRaises(ValueError):
            build_positions(txs, make_settings())


class TestPortfolio(unittest.TestCase):
    def setUp(self):
        self.settings = make_settings()
        self.txs = [
            tx("2024-01-01", "AAPL", "BUY", 10, 100),          # 1,000 USD
            tx("2024-01-01", "005930.KS", "BUY", 10, 70000),   # 700,000 KRW
        ]
        # AAPL 150 USD * 10 * 1300 = 1,950,000 / 삼성 80,000 * 10 = 800,000
        self.book = make_book(
            {"AAPL": (150.0, 140.0, "USD"), "005930.KS": (80000.0, 79000.0, "KRW")},
            {"USD": 1300.0},
        )

    def test_valuation_and_weights(self):
        pf = build_portfolio(self.txs, self.settings, self.book)
        self.assertEqual(pf.total_value, 2_750_000)
        aapl = next(p for p in pf.positions if p.asset.ticker == "AAPL")
        self.assertEqual(aapl.market_value_base, 1_950_000)
        self.assertAlmostEqual(aapl.weight, 1_950_000 / 2_750_000 * 100)
        self.assertAlmostEqual(sum(p.weight for p in pf.positions), 100.0)

    def test_currency_conversion_of_pl(self):
        pf = build_portfolio(self.txs, self.settings, self.book)
        aapl = next(p for p in pf.positions if p.asset.ticker == "AAPL")
        self.assertEqual(aapl.unrealized_pl_local, 500)
        self.assertEqual(aapl.unrealized_pl_base, 650_000)
        self.assertAlmostEqual(aapl.return_pct, 50.0)

    def test_cash_included_in_weights(self):
        pf = build_portfolio(self.txs, self.settings, self.book, cash=250_000)
        self.assertEqual(pf.total_value, 3_000_000)
        self.assertAlmostEqual(sum(p.weight for p in pf.positions), 100 - 250_000 / 30_000)

    def test_country_breakdown(self):
        pf = build_portfolio(self.txs, self.settings, self.book)
        by_country = {b.key: b for b in pf.breakdown("country")}
        self.assertEqual(by_country["US"].market_value, 1_950_000)
        self.assertEqual(by_country["KR"].market_value, 800_000)
        self.assertAlmostEqual(by_country["KR"].weight, 800_000 / 2_750_000 * 100)

    def test_missing_price_is_valued_at_cost(self):
        # 0 원으로 빼버리면 방금 넣은 종목이 총 자산에서 사라지고
        # 국가·섹터 비중도 안 나와서 경고가 통째로 죽는다.
        book = make_book({"AAPL": (150.0, 140.0, "USD")}, {"USD": 1300.0})
        pf = build_portfolio(self.txs, self.settings, book)
        self.assertIn("005930.KS", pf.missing_prices)
        kr = next(p for p in pf.positions if p.asset.ticker == "005930.KS")
        self.assertTrue(kr.valued_at_cost)
        self.assertIsNone(kr.market_value_base)  # 현재 가치는 모르는 채로 둔다
        self.assertEqual(kr.value_base, 700_000)  # 10주 x 70,000 매입가
        self.assertEqual(pf.total_value, 1_950_000 + 700_000)
        self.assertEqual(pf.priced_value, 1_950_000)  # 시세 받은 몫은 따로 남는다
        by_country = {b.key: b for b in pf.breakdown("country")}
        self.assertEqual(by_country["KR"].market_value, 700_000)

    def test_day_pl(self):
        pf = build_portfolio(self.txs, self.settings, self.book)
        # AAPL (150-140)*10*1300 = 130,000 / 삼성 (80000-79000)*10 = 10,000
        self.assertEqual(pf.day_pl, 140_000)


if __name__ == "__main__":
    unittest.main()
