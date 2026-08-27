# -*- coding: utf-8 -*-
"""
SOP Word 일괄변경 도구 - 실행 진입점

실행 방법:
    python main.py

EXE 로 만들려면 build.bat 을 더블클릭하세요.
"""

from __future__ import annotations

import os
import sys
import traceback

# PyInstaller 로 묶었을 때나 다른 폴더에서 실행했을 때도
# 같은 폴더의 모듈(gui.py 등)을 찾을 수 있게 경로를 보강한다.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)


def show_fatal_error(message: str) -> None:
    """GUI 를 띄우지 못한 치명적 오류를 사용자에게 알린다."""
    try:
        import tkinter as tk
        from tkinter import messagebox

        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("SOP Word 일괄변경 도구 - 실행 오류", message)
        root.destroy()
    except Exception:
        # GUI 자체를 못 쓰는 상황이면 콘솔로 출력한다.
        print(message, file=sys.stderr)


def main() -> int:
    try:
        import tkinter  # noqa: F401  (사전 확인용 import)
    except ImportError:
        show_fatal_error(
            "tkinter 를 찾을 수 없습니다.\n\n"
            "Python 을 설치할 때 'tcl/tk and IDLE' 옵션을 함께 설치해 주세요."
        )
        return 1

    try:
        import gui

        gui.run()
        return 0
    except Exception:
        show_fatal_error(
            "프로그램 실행 중 오류가 발생했습니다.\n\n" + traceback.format_exc()
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
