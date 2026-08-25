"""폰/엑셀에서 넘어온 파일을 얼마나 관대하게 읽는지 검증."""

import tempfile
import unittest
from pathlib import Path

from portfolio.loader import LoaderError, append_transactions, load_transactions


class TestLoader(unittest.TestCase):
    def _write(self, name, text):
        path = Path(self.tmp.name) / name
        path.write_text(text, encoding="utf-8")
        return path

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def test_standard_csv(self):
        p = self._write("a.csv", "date,ticker,side,quantity,price,fee\n"
                                 "2024-01-02,AAPL,BUY,10,150.5,1.2\n")
        t = load_transactions(p)[0]
        self.assertEqual((t.ticker, t.side, t.quantity, t.price, t.fee),
                         ("AAPL", "BUY", 10.0, 150.5, 1.2))

    def test_korean_headers_and_words(self):
        p = self._write("b.csv", "날짜,종목코드,매매구분,수량,단가,수수료,계좌\n"
                                 "2024.03.05,005930.KS,매수,\"1,000\",\"70,500\",520,키움\n"
                                 "2024/04/01,005930.KS,매도,100,75000,600,키움\n")
        txs = load_transactions(p)
        self.assertEqual(txs[0].quantity, 1000.0)   # 천단위 쉼표
        self.assertEqual(txs[0].price, 70500.0)
        self.assertEqual(txs[0].account, "키움")
        self.assertEqual(txs[1].side, "SELL")

    def test_tab_separated_and_bom(self):
        p = self._write("c.csv", "﻿date\tticker\tside\tquantity\tprice\n"
                                 "2024-05-01\tTSLA\tbuy\t3\t200\n")
        self.assertEqual(load_transactions(p)[0].ticker, "TSLA")

    def test_json_input(self):
        p = self._write("d.json",
                        '[{"date":"2024-06-01","ticker":"AMZN","side":"BUY",'
                        '"quantity":5,"price":180}]')
        self.assertEqual(load_transactions(p)[0].ticker, "AMZN")

    def test_missing_side_defaults_to_buy(self):
        p = self._write("e.csv", "date,ticker,quantity,price\n2024-01-01,AAPL,1,100\n")
        self.assertEqual(load_transactions(p)[0].side, "BUY")

    def test_currency_symbols_are_stripped(self):
        p = self._write("f.csv", "날짜,종목,구분,주수,가격\n2024-01-01,AAPL,매수,2,$150.25\n")
        self.assertEqual(load_transactions(p)[0].price, 150.25)

    def test_bad_date_raises_with_line_number(self):
        p = self._write("g.csv", "date,ticker,side,quantity,price\n"
                                 "언젠가,AAPL,BUY,1,100\n")
        with self.assertRaises(LoaderError) as cm:
            load_transactions(p)
        self.assertIn("g.csv:2", str(cm.exception))

    def test_transactions_are_sorted_by_date(self):
        p = self._write("h.csv", "date,ticker,side,quantity,price\n"
                                 "2024-05-01,AAPL,BUY,1,100\n"
                                 "2024-01-01,AAPL,BUY,1,90\n")
        self.assertEqual([t.date.isoformat() for t in load_transactions(p)],
                         ["2024-01-01", "2024-05-01"])

    def test_append_skips_duplicates(self):
        src = self._write("src.csv", "date,ticker,side,quantity,price\n"
                                     "2024-01-01,AAPL,BUY,1,100\n"
                                     "2024-02-01,AAPL,BUY,2,110\n")
        target = Path(self.tmp.name) / "master.csv"
        self.assertEqual(append_transactions(target, load_transactions(src)), 2)
        self.assertEqual(append_transactions(target, load_transactions(src)), 0)
        self.assertEqual(len(load_transactions(target)), 2)


if __name__ == "__main__":
    unittest.main()
