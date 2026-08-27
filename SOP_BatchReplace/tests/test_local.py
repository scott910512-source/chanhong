# -*- coding: utf-8 -*-
"""
SOP Word 일괄변경 도구 - 로컬 테스트

Word COM 과 tkinter 가 없는 환경에서도 검증 가능한 부분을 테스트한다.
    - 규칙 저장/로드/추가/수정/삭제/순서변경/중복검사
    - 대상 파일 탐색(확장자, ~$ 임시파일, 백업폴더 제외, 재귀)
    - 경로 정규화
    - 백업 폴더 이름 생성 / 하위 구조 유지 복사
    - 로그 텍스트 생성

실행: python tests/test_local.py
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from rule_manager import AppSettings, RuleError, RuleManager  # noqa: E402
import word_processor as wp  # noqa: E402


class RuleManagerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "rules.json"
        self.rm = RuleManager(self.path)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_creates_file_when_missing(self) -> None:
        self.assertTrue(self.path.exists())
        self.assertEqual(len(self.rm), 0)

    def test_add_and_persist(self) -> None:
        self.rm.add("생산 관리자", "생산 관리감독자")
        self.rm.add("DMA 케비넷", "DMA Cabinet")
        reloaded = RuleManager(self.path)
        self.assertEqual(len(reloaded), 2)
        self.assertEqual(reloaded.get(0)["find"], "생산 관리자")
        self.assertEqual(reloaded.get(1)["replace"], "DMA Cabinet")

    def test_empty_find_rejected(self) -> None:
        with self.assertRaises(RuleError):
            self.rm.add("", "무언가")
        with self.assertRaises(RuleError):
            self.rm.add("   ", "무언가")

    def test_empty_replace_allowed(self) -> None:
        rule = self.rm.add("임시문구", "")
        self.assertEqual(rule["replace"], "")
        self.assertEqual(len(RuleManager(self.path)), 1)

    def test_duplicate_rejected(self) -> None:
        self.rm.add("가", "나")
        with self.assertRaises(RuleError):
            self.rm.add("가", "나")
        # 바꿀 문구가 다르면 허용
        self.rm.add("가", "다")
        self.assertEqual(len(self.rm), 2)

    def test_update_allows_same_index(self) -> None:
        self.rm.add("가", "나")
        self.rm.update(0, "가", "나", False)  # 자기 자신은 중복으로 보지 않는다
        self.assertFalse(self.rm.get(0)["enabled"])

    def test_too_long_find_rejected(self) -> None:
        with self.assertRaises(RuleError):
            self.rm.add("가" * 256, "나")

    def test_toggle_and_set_all(self) -> None:
        self.rm.add("가", "나")
        self.rm.add("다", "라")
        self.rm.set_all(False)
        self.assertEqual(len(self.rm.enabled_rules()), 0)
        self.rm.toggle(0)
        self.assertEqual(len(self.rm.enabled_rules()), 1)
        self.rm.set_all(True)
        self.assertEqual(len(self.rm.enabled_rules()), 2)
        self.assertEqual(len(RuleManager(self.path).enabled_rules()), 2)

    def test_move_order_persisted(self) -> None:
        self.rm.add("1번", "A")
        self.rm.add("2번", "B")
        self.rm.add("3번", "C")
        new_index = self.rm.move(2, -1)
        self.assertEqual(new_index, 1)
        self.assertEqual([r["find"] for r in RuleManager(self.path).rules], ["1번", "3번", "2번"])
        # 경계 밖으로는 이동하지 않는다
        self.assertEqual(self.rm.move(0, -1), 0)
        self.assertEqual(self.rm.move(2, 1), 2)

    def test_delete(self) -> None:
        self.rm.add("가", "나")
        self.rm.add("다", "라")
        self.rm.delete(0)
        self.assertEqual([r["find"] for r in RuleManager(self.path).rules], ["다"])

    def test_broken_file_does_not_crash(self) -> None:
        self.path.write_text("{ 이건 JSON 이 아님", encoding="utf-8")
        rm = RuleManager(self.path)
        self.assertEqual(len(rm), 0)

    def test_accepts_dict_wrapped_format(self) -> None:
        self.path.write_text(
            '{"rules": [{"enabled": true, "find": "가", "replace": "나"},'
            ' {"bad": 1}, {"enabled": false, "find": "", "replace": "x"}]}',
            encoding="utf-8",
        )
        rm = RuleManager(self.path)
        self.assertEqual(len(rm), 1)  # 잘못된 항목은 걸러진다

    def test_settings_roundtrip(self) -> None:
        settings_path = Path(self.tmp.name) / "settings.json"
        s = AppSettings(settings_path)
        s.set("last_folder", "C:\\SOP\\생산절차서")
        s.set("recursive", True)
        s2 = AppSettings(settings_path)
        self.assertEqual(s2.get("last_folder"), "C:\\SOP\\생산절차서")
        self.assertTrue(s2.get("recursive"))


class FileCollectionTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "생산절차서"
        (self.root / "하위폴더").mkdir(parents=True)
        (self.root / "생산절차서_원본백업_20260101_090000").mkdir(parents=True)

        self._touch(self.root / "DMA_Cabinet_SOP.docx")
        self._touch(self.root / "TMA_작업절차서.docm")
        self._touch(self.root / "구버전.doc")
        self._touch(self.root / "~$DMA_Cabinet_SOP.docx")   # Word 임시 파일
        self._touch(self.root / "메모.txt")                  # 대상 아님
        self._touch(self.root / "설명서.pdf")                # 대상 아님
        self._touch(self.root / "하위폴더" / "세부절차_한글이름.docx")
        self._touch(self.root / "생산절차서_원본백업_20260101_090000" / "백업본.docx")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    @staticmethod
    def _touch(path: Path) -> None:
        path.write_text("dummy", encoding="utf-8")

    def test_non_recursive(self) -> None:
        files = wp.collect_word_files(self.root, recursive=False)
        names = sorted(os.path.basename(f) for f in files)
        self.assertEqual(names, ["DMA_Cabinet_SOP.docx", "TMA_작업절차서.docm", "구버전.doc"])

    def test_recursive_includes_subfolder_excludes_backup(self) -> None:
        files = wp.collect_word_files(self.root, recursive=True)
        names = sorted(os.path.basename(f) for f in files)
        self.assertIn("세부절차_한글이름.docx", names)
        self.assertNotIn("백업본.docx", names)
        self.assertNotIn("~$DMA_Cabinet_SOP.docx", names)
        self.assertEqual(len(files), 4)

    def test_missing_folder_returns_empty(self) -> None:
        self.assertEqual(wp.collect_word_files(self.root / "없는폴더", True), [])

    def test_helpers(self) -> None:
        self.assertTrue(wp.is_temp_word_file("~$a.docx"))
        self.assertFalse(wp.is_temp_word_file("a.docx"))
        self.assertTrue(wp.has_word_extension("A.DOCX"))
        self.assertTrue(wp.has_word_extension("a.DocM"))
        self.assertFalse(wp.has_word_extension("a.pdf"))
        self.assertTrue(wp.is_backup_dir_name("생산절차서_원본백업_20260101_090000"))
        self.assertTrue(wp.is_backup_dir_name("Backup"))
        self.assertTrue(wp.is_backup_dir_name("백업"))
        self.assertFalse(wp.is_backup_dir_name("생산절차서"))


class PathAndBackupTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "SOP" / "생산절차서"
        (self.root / "1공정").mkdir(parents=True)
        (self.root / "문서A.docx").write_text("A", encoding="utf-8")
        (self.root / "1공정" / "문서B.docx").write_text("B", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_normalize_path(self) -> None:
        a = wp.normalize_path(str(self.root / "문서A.docx"))
        b = wp.normalize_path(str(self.root / "." / "문서A.docx"))
        self.assertEqual(a, b)
        self.assertTrue(os.path.isabs(a))

    def test_backup_root_name(self) -> None:
        backup = wp.make_backup_root(str(self.root), timestamp="20260827_143500")
        self.assertEqual(
            os.path.basename(backup), "생산절차서_원본백업_20260827_143500"
        )
        self.assertEqual(
            wp.normalize_path(os.path.dirname(backup)),
            wp.normalize_path(str(self.root.parent)),
        )

    def test_backup_preserves_structure(self) -> None:
        backup_root = wp.make_backup_root(str(self.root), timestamp="20260827_143500")
        for src in wp.collect_word_files(self.root, recursive=True):
            wp.backup_file(src, str(self.root), backup_root)
        self.assertTrue(os.path.isfile(os.path.join(backup_root, "문서A.docx")))
        self.assertTrue(os.path.isfile(os.path.join(backup_root, "1공정", "문서B.docx")))
        with open(os.path.join(backup_root, "1공정", "문서B.docx"), encoding="utf-8") as f:
            self.assertEqual(f.read(), "B")

    def test_escape_find_text(self) -> None:
        self.assertEqual(wp.escape_find_text("생산 관리자"), "생산 관리자")
        self.assertEqual(wp.escape_find_text("A^pB"), "A^94pB")


class LogTest(unittest.TestCase):
    def test_log_text_contains_key_sections(self) -> None:
        rules = [
            {"enabled": True, "find": "생산 관리자", "replace": "생산 관리감독자"},
            {"enabled": True, "find": "DMA 케비넷", "replace": "DMA Cabinet"},
        ]
        result = wp.JobResult(
            preview=False,
            folder="C:\\SOP\\생산절차서",
            recursive=True,
            backup_root="C:\\SOP\\생산절차서_원본백업_20260827_143500",
            rules=rules,
            started_at=datetime(2026, 8, 27, 14, 35, 0),
            ended_at=datetime(2026, 8, 27, 14, 36, 32),
        )
        result.results = [
            wp.FileResult(
                "C:\\SOP\\생산절차서\\DMA_Cabinet.docx",
                wp.STATUS_CHANGED,
                counts={"생산 관리자 -> 생산 관리감독자": 3},
                total=3,
            ),
            wp.FileResult(
                "C:\\SOP\\생산절차서\\TMA_SOP.docx",
                wp.STATUS_SKIPPED_OPEN,
                message="Word 에서 현재 열려 있음",
            ),
            wp.FileResult(
                "C:\\SOP\\생산절차서\\Test_SOP.docx",
                wp.STATUS_ERROR,
                message="파일이 읽기 전용입니다.",
            ),
            wp.FileResult("C:\\SOP\\생산절차서\\기타.docx", wp.STATUS_UNCHANGED),
        ]

        self.assertEqual(result.total_files, 4)
        self.assertEqual(result.changed_files, 1)
        self.assertEqual(result.unchanged_files, 1)
        self.assertEqual(len(result.skipped_open_files), 1)
        self.assertEqual(len(result.error_files), 1)
        self.assertEqual(result.total_replacements, 3)
        self.assertEqual(
            result.per_rule_counts(),
            {"생산 관리자 -> 생산 관리감독자": 3, "DMA 케비넷 -> DMA Cabinet": 0},
        )

        text = wp.build_log_text(result)
        for expected in (
            "[SOP Word 일괄변경]",
            "작업시작: 2026-08-27 14:35:00",
            "C:\\SOP\\생산절차서",
            "생산 관리자 -> 생산 관리감독자",
            "[변경]",
            "[SKIP]",
            "사유: Word에서 현재 열려 있음",
            "[오류]",
            "처리 파일: 4",
            "변경 파일: 1",
            "총 치환: 3",
            "원본 백업:",
            "2026-08-27 14:36:32",
        ):
            self.assertIn(expected, text, f"로그에 '{expected}' 가 없습니다")


class ComAbsentTest(unittest.TestCase):
    def test_open_documents_empty_without_win32(self) -> None:
        if not wp.WIN32_AVAILABLE:
            self.assertEqual(wp.list_open_documents(), [])
            self.assertEqual(wp.open_document_key_set(), set())

    def test_job_reports_fatal_error_without_win32(self) -> None:
        if wp.WIN32_AVAILABLE:
            self.skipTest("Windows 환경에서는 건너뜀")
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "a.docx").write_text("x", encoding="utf-8")
            job = wp.BatchJob(tmp, False, [{"enabled": True, "find": "가", "replace": "나"}])
            result = job.run()
            self.assertIn("pywin32", result.fatal_error)
            self.assertEqual(result.total_files, 0)
            # 백업 폴더를 만들지 않았는지 확인 (Word 없이 파일을 건드리면 안 됨)
            self.assertEqual(result.backup_root, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
