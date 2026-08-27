# -*- coding: utf-8 -*-
"""
GUI 로직 테스트

실제 tkinter 가 없는 환경에서도 gui.py 를 import 할 수 있도록 대역 모듈을 쓰고,
화면 위젯과 무관한 순수 로직(결과 요약 문구 생성)을 검증한다.

실행: python tests/test_gui_logic.py
"""

from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

try:
    import tkinter  # noqa: F401
except ImportError:
    # tkinter 가 없으면 테스트용 대역 모듈을 쓴다.
    sys.path.insert(0, str(HERE / "stubs"))

import word_processor as wp  # noqa: E402
import gui  # noqa: E402


def sample_result(preview: bool) -> wp.JobResult:
    rules = [
        {"enabled": True, "find": "생산 관리자", "replace": "생산 관리감독자"},
        {"enabled": True, "find": "DMA 케비넷", "replace": "DMA Cabinet"},
        {"enabled": True, "find": "점검 담당자", "replace": "작업 담당자"},
    ]
    result = wp.JobResult(
        preview=preview,
        folder="C:\\SOP\\생산절차서",
        recursive=True,
        backup_root="" if preview else "C:\\SOP\\생산절차서_원본백업_20260827_143500",
        rules=rules,
        started_at=datetime(2026, 8, 27, 14, 35, 0),
        ended_at=datetime(2026, 8, 27, 14, 36, 32),
    )
    result.results = [
        wp.FileResult(
            "C:\\SOP\\생산절차서\\A.docx",
            wp.STATUS_CHANGED,
            counts={"생산 관리자 -> 생산 관리감독자": 17, "DMA 케비넷 -> DMA Cabinet": 9},
            total=26,
        ),
        wp.FileResult(
            "C:\\SOP\\생산절차서\\B.docx",
            wp.STATUS_CHANGED,
            counts={"점검 담당자 -> 작업 담당자": 4},
            total=4,
        ),
        wp.FileResult("C:\\SOP\\생산절차서\\C.docx", wp.STATUS_UNCHANGED),
        wp.FileResult(
            "C:\\SOP\\생산절차서\\DMA_Cabinet_SOP.docx",
            wp.STATUS_SKIPPED_OPEN,
            message="Word 에서 현재 열려 있음",
        ),
        wp.FileResult(
            "C:\\SOP\\생산절차서\\Test_SOP.docx",
            wp.STATUS_ERROR,
            message="파일이 읽기 전용입니다.",
        ),
    ]
    return result


class SummaryTest(unittest.TestCase):
    def test_replace_summary(self) -> None:
        result = sample_result(preview=False)
        # _build_summary 는 self 를 쓰지 않으므로 언바운드로 호출할 수 있다.
        text = gui.MainApp._build_summary(None, result, "C:\\...\\logs\\20260827_143500.log")

        for expected in (
            "일괄 변경 완료",
            "전체 Word 파일 : 5개",
            "변경된 파일 : 2개",
            "변경 없음 : 1개",
            "열려 있어 제외 : 1개",
            "오류 : 1개",
            "총 치환 횟수 : 30회",
            "생산 관리자 -> 생산 관리감독자 : 17건",
            "DMA 케비넷 -> DMA Cabinet : 9건",
            "점검 담당자 -> 작업 담당자 : 4건",
            "C:\\SOP\\생산절차서_원본백업_20260827_143500",
            "20260827_143500.log",
            "제외/오류 파일 2개",
        ):
            self.assertIn(expected, text, f"요약에 '{expected}' 가 없습니다")

    def test_preview_summary(self) -> None:
        result = sample_result(preview=True)
        text = gui.MainApp._build_summary(None, result, "")

        self.assertIn("검사 결과", text)
        self.assertIn("실제 파일은 변경하지 않았습니다", text)
        self.assertIn("대상 Word 파일 : 5개", text)
        self.assertIn("적용 규칙 : 3개", text)
        self.assertIn("변경 예상 문서 : 2개", text)
        self.assertIn("예상 치환 횟수 : 30회", text)
        self.assertNotIn("원본 백업", text)

    def test_cancelled_note(self) -> None:
        result = sample_result(preview=False)
        result.cancelled = True
        text = gui.MainApp._build_summary(None, result, "")
        self.assertIn("사용자가 작업을 중단했습니다", text)


class ModuleSurfaceTest(unittest.TestCase):
    def test_expected_names_exist(self) -> None:
        for name in ("MainApp", "RuleDialog", "TextWindow", "run", "APP_TITLE"):
            self.assertTrue(hasattr(gui, name), f"gui.{name} 가 없습니다")
        for name in (
            "_add_rule", "_edit_rule", "_delete_rule", "_set_all", "_move_rule",
            "_toggle_selected", "_choose_folder", "_start_preview", "_start_replace",
            "_cancel_job", "_show_skip_details", "_on_close", "_open_settings_folder",
        ):
            self.assertTrue(hasattr(gui.MainApp, name), f"MainApp.{name} 가 없습니다")


if __name__ == "__main__":
    unittest.main(verbosity=2)
