# -*- coding: utf-8 -*-
"""
전체 테스트 실행기.

    python tests/run_all.py
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

try:
    import tkinter  # noqa: F401
except ImportError:
    sys.path.insert(0, str(HERE / "stubs"))


if __name__ == "__main__":
    loader = unittest.TestLoader()
    suite = loader.discover(str(HERE), pattern="test_*.py")
    runner = unittest.TextTestRunner(verbosity=2)
    sys.exit(0 if runner.run(suite).wasSuccessful() else 1)
