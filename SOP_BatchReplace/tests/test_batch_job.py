# -*- coding: utf-8 -*-
"""
BatchJob 흐름 테스트 (가짜 Word COM 사용)

실제 Microsoft Word 없이 다음을 검증한다.
    - StoryRanges + NextStoryRange 전 영역 치환
    - 규칙 적용 순서 (목록 순서대로)
    - 규칙별 치환 건수 집계
    - 사전 확인 모드에서 파일 미변경
    - 원본 백업 후 변경 / 백업 실패 시 미변경
    - 열려 있는 문서 SKIP, 읽기 전용 SKIP
    - 한 문서 오류가 나도 전체 작업 계속
    - Word 인스턴스 종료 및 CoInitialize/CoUninitialize 짝 맞춤
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import word_processor as wp  # noqa: E402
import fake_word  # noqa: E402


def rule(find: str, replace: str, enabled: bool = True) -> dict:
    return {"enabled": enabled, "find": find, "replace": replace}


class BatchJobTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.folder = os.path.join(self.tmp.name, "생산절차서")
        os.makedirs(self.folder)

        # word_processor 의 COM 의존성을 가짜로 교체한다.
        # _create_word 자체는 실제 코드를 그대로 실행시켜서
        # Visible/DisplayAlerts/AutomationSecurity 설정까지 검증한다.
        self._saved = (wp.WIN32_AVAILABLE, wp.pythoncom, wp.com_error, wp.win32com)
        self.pythoncom = fake_word.FakePythoncom()
        wp.WIN32_AVAILABLE = True
        wp.pythoncom = self.pythoncom
        wp.com_error = fake_word.FakeError
        wp.win32com = fake_word.FakeWin32com

        fake_word.FakeWordApp.instances = []

        # 열려 있는 문서 목록도 테스트에서 제어한다.
        self._saved_open = wp.open_document_key_set
        self.open_docs: set = set()
        wp.open_document_key_set = lambda: set(self.open_docs)

    def tearDown(self) -> None:
        wp.WIN32_AVAILABLE, wp.pythoncom, wp.com_error, wp.win32com = self._saved
        wp.open_document_key_set = self._saved_open
        self.tmp.cleanup()

    def doc(self, name: str, stories, **extra) -> str:
        path = os.path.join(self.folder, name)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        fake_word.write_doc(path, stories, **extra)
        return path

    def run_job(self, rules, preview=False, recursive=False) -> wp.JobResult:
        job = wp.BatchJob(self.folder, recursive, rules, preview=preview)
        return job.run()


class ReplacementTest(BatchJobTestBase):
    def test_replaces_across_all_story_ranges(self) -> None:
        path = self.doc(
            "DMA_Cabinet_SOP.docx",
            [
                ["본문: 생산 관리자 확인. 표 안에도 생산 관리자."],   # 본문 스토리
                ["머리글 생산 관리자", "머리글 텍스트상자 생산 관리자"],  # NextStoryRange 체인
                ["바닥글: 생산 관리자"],
            ],
        )
        result = self.run_job([rule("생산 관리자", "생산 관리감독자")])

        self.assertEqual(result.total_replacements, 5)
        self.assertEqual(result.changed_files, 1)
        stories = fake_word.read_stories(path)
        joined = " ".join(t for chain in stories for t in chain)
        self.assertNotIn("생산 관리자", joined)
        self.assertEqual(joined.count("생산 관리감독자"), 5)

    def test_rules_applied_in_list_order(self) -> None:
        # 1번이 만든 결과에 2번이 다시 적용되어야 한다.
        path = self.doc("순서.docx", [["생산관리자 가 작업한다"]])
        result = self.run_job(
            [rule("생산관리자", "생산 관리자"), rule("생산 관리자", "생산 관리감독자")]
        )
        self.assertEqual(fake_word.read_stories(path)[0][0], "생산 관리감독자 가 작업한다")
        self.assertEqual(
            result.per_rule_counts(),
            {"생산관리자 -> 생산 관리자": 1, "생산 관리자 -> 생산 관리감독자": 1},
        )

    def test_empty_replacement_deletes_text(self) -> None:
        path = self.doc("삭제.docx", [["앞[임시문구]뒤"]])
        result = self.run_job([rule("[임시문구]", "")])
        self.assertEqual(fake_word.read_stories(path)[0][0], "앞뒤")
        self.assertEqual(result.total_replacements, 1)

    def test_no_match_leaves_file_untouched(self) -> None:
        path = self.doc("변경없음.docx", [["아무 관련 없는 내용"]])
        before = Path(path).read_text(encoding="utf-8")
        result = self.run_job([rule("생산 관리자", "생산 관리감독자")])
        self.assertEqual(result.unchanged_files, 1)
        self.assertEqual(result.changed_files, 0)
        self.assertEqual(Path(path).read_text(encoding="utf-8"), before)

    def test_caret_is_literal(self) -> None:
        path = self.doc("캐럿.docx", [["온도 25^C 유지"]])
        self.run_job([rule("25^C", "25도")])
        self.assertEqual(fake_word.read_stories(path)[0][0], "온도 25도 유지")

    def test_only_enabled_rules_are_passed(self) -> None:
        # BatchJob 은 넘겨받은 규칙만 적용한다 (GUI 가 enabled_rules() 로 걸러 넘김)
        path = self.doc("온오프.docx", [["가 나"]])
        self.run_job([rule("가", "A")])
        self.assertEqual(fake_word.read_stories(path)[0][0], "A 나")


class PreviewTest(BatchJobTestBase):
    def test_preview_does_not_modify_or_backup(self) -> None:
        path = self.doc("사전확인.docx", [["생산 관리자 생산 관리자"]])
        before = Path(path).read_text(encoding="utf-8")

        result = self.run_job([rule("생산 관리자", "생산 관리감독자")], preview=True)

        self.assertEqual(result.total_replacements, 2)
        self.assertEqual(result.changed_files, 1)   # '변경 예상' 문서
        self.assertEqual(Path(path).read_text(encoding="utf-8"), before)
        self.assertEqual(result.backup_root, "")
        # 백업 폴더가 만들어지지 않았는지 확인
        siblings = os.listdir(os.path.dirname(self.folder))
        self.assertEqual(siblings, ["생산절차서"])
        # 문서는 읽기 전용으로 열렸고 저장되지 않았다
        app = fake_word.FakeWordApp.instances[0]
        self.assertEqual(sum(d.save_count for d in app.documents), 0)


class BackupTest(BatchJobTestBase):
    def test_backup_created_with_original_content(self) -> None:
        self.doc("A.docx", [["생산 관리자"]])
        os.makedirs(os.path.join(self.folder, "1공정"))
        self.doc(os.path.join("1공정", "B.docx"), [["생산 관리자"]])

        result = self.run_job([rule("생산 관리자", "생산 관리감독자")], recursive=True)

        self.assertTrue(result.backup_root)
        self.assertTrue(os.path.isdir(result.backup_root))
        # 하위 폴더 구조 유지
        backup_b = os.path.join(result.backup_root, "1공정", "B.docx")
        self.assertTrue(os.path.isfile(backup_b))
        # 백업본에는 원본(치환 전) 내용이 들어 있어야 한다
        with open(backup_b, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["stories"][0][0], "생산 관리자")
        # 원본은 치환되어 있어야 한다
        self.assertEqual(
            fake_word.read_stories(os.path.join(self.folder, "1공정", "B.docx"))[0][0],
            "생산 관리감독자",
        )

    def test_backup_failure_skips_modification(self) -> None:
        path = self.doc("백업실패.docx", [["생산 관리자"]])
        before = Path(path).read_text(encoding="utf-8")

        original_backup = wp.backup_file

        def failing_backup(src, source_root, backup_root):
            raise OSError("디스크 공간 부족")

        wp.backup_file = failing_backup
        try:
            result = self.run_job([rule("생산 관리자", "생산 관리감독자")])
        finally:
            wp.backup_file = original_backup

        self.assertEqual(len(result.error_files), 1)
        self.assertIn("백업 실패", result.error_files[0].message)
        self.assertEqual(Path(path).read_text(encoding="utf-8"), before)

    def test_backup_folder_excluded_from_next_run(self) -> None:
        self.doc("A.docx", [["생산 관리자"]])
        result = self.run_job([rule("생산 관리자", "생산 관리감독자")], recursive=True)
        backup_name = os.path.basename(result.backup_root)
        self.assertIn("_원본백업_", backup_name)
        # 백업 폴더가 대상 폴더 바깥(형제)에 생기므로 재탐색 대상이 아니다
        self.assertEqual(len(wp.collect_word_files(self.folder, True)), 1)


class SkipAndErrorTest(BatchJobTestBase):
    def test_open_document_is_skipped(self) -> None:
        open_path = self.doc("열린문서.docx", [["생산 관리자"]])
        other_path = self.doc("닫힌문서.docx", [["생산 관리자"]])
        # Word 가 알려주는 경로가 정규화되어 있지 않아도 같은 파일로 인식되어야 한다
        messy = os.path.join(self.folder, ".", "..", "생산절차서", "열린문서.docx")
        self.open_docs = {wp.normalize_path(messy)}

        before = Path(open_path).read_text(encoding="utf-8")
        result = self.run_job([rule("생산 관리자", "생산 관리감독자")])

        self.assertEqual(len(result.skipped_open_files), 1)
        self.assertEqual(result.skipped_open_files[0].name, "열린문서.docx")
        self.assertEqual(Path(open_path).read_text(encoding="utf-8"), before)
        # 열린 문서 때문에 전체 작업이 멈추면 안 된다
        self.assertEqual(result.changed_files, 1)
        self.assertEqual(
            fake_word.read_stories(other_path)[0][0], "생산 관리감독자"
        )
        # 열려 있는 문서는 백업조차 하지 않는다
        self.assertFalse(
            os.path.exists(os.path.join(result.backup_root, "열린문서.docx"))
        )

    def test_readonly_file_is_skipped(self) -> None:
        path = self.doc("읽기전용.docx", [["생산 관리자"]])
        self.doc("정상.docx", [["생산 관리자"]])
        before = Path(path).read_text(encoding="utf-8")

        # root 로 테스트를 돌리면 chmod 가 무력화되므로 판정 함수를 가로챈다.
        original = wp.is_read_only_file
        wp.is_read_only_file = lambda p: wp.normalize_path(p) == wp.normalize_path(path)
        try:
            result = self.run_job([rule("생산 관리자", "생산 관리감독자")])
        finally:
            wp.is_read_only_file = original

        self.assertEqual(Path(path).read_text(encoding="utf-8"), before)

        self.assertEqual(len(result.skipped_readonly_files), 1)
        self.assertEqual(result.skipped_readonly_files[0].name, "읽기전용.docx")
        self.assertEqual(result.changed_files, 1)

    def test_password_document_becomes_error_and_job_continues(self) -> None:
        self.doc("암호문서.docx", [["생산 관리자"]], error="password")
        normal = self.doc("정상문서.docx", [["생산 관리자"]])

        result = self.run_job([rule("생산 관리자", "생산 관리감독자")])

        self.assertEqual(len(result.error_files), 1)
        self.assertEqual(result.error_files[0].name, "암호문서.docx")
        self.assertIn("암호", result.error_files[0].message)
        self.assertEqual(result.changed_files, 1)
        self.assertEqual(fake_word.read_stories(normal)[0][0], "생산 관리감독자")

    def test_word_readonly_open_is_skipped(self) -> None:
        # 파일 권한은 정상이지만 Word 가 읽기 전용으로 여는 경우
        path = self.doc("워드읽기전용.docx", [["생산 관리자"]], read_only=True)
        before = Path(path).read_text(encoding="utf-8")
        result = self.run_job([rule("생산 관리자", "생산 관리감독자")])
        self.assertEqual(len(result.skipped_readonly_files), 1)
        self.assertEqual(Path(path).read_text(encoding="utf-8"), before)


class LifecycleTest(BatchJobTestBase):
    def test_word_instance_quits_and_com_balanced(self) -> None:
        self.doc("A.docx", [["생산 관리자"]])
        self.run_job([rule("생산 관리자", "생산 관리감독자")])

        self.assertEqual(len(fake_word.FakeWordApp.instances), 1)
        app = fake_word.FakeWordApp.instances[0]
        self.assertEqual(app.quit_called, 1)
        self.assertFalse(app.Visible)
        self.assertEqual(app.DisplayAlerts, 0)
        self.assertEqual(app.AutomationSecurity, 3)  # 매크로 차단
        self.assertEqual(self.pythoncom.init_count, 1)
        self.assertEqual(self.pythoncom.uninit_count, 1)
        # 모든 문서가 닫혔는지 확인
        self.assertEqual(len(app.documents), 0)

    def test_word_quits_even_when_processing_raises(self) -> None:
        self.doc("A.docx", [["생산 관리자"]])
        original = wp.BatchJob._process_file

        def boom(_self, _path):
            raise RuntimeError("예상치 못한 오류")

        wp.BatchJob._process_file = boom
        try:
            with self.assertRaises(RuntimeError):
                self.run_job([rule("생산 관리자", "생산 관리감독자")])
        finally:
            wp.BatchJob._process_file = original

        app = fake_word.FakeWordApp.instances[0]
        self.assertEqual(app.quit_called, 1)          # Word 프로세스가 남지 않는다
        self.assertEqual(self.pythoncom.uninit_count, 1)

    def test_track_revisions_disabled_then_restored(self) -> None:
        self.doc("추적.docx", [["생산 관리자"]], track_revisions=True)
        self.run_job([rule("생산 관리자", "생산 관리감독자")])
        # 저장된 파일에 track_revisions 값이 유지되어야 한다
        with open(os.path.join(self.folder, "추적.docx"), encoding="utf-8") as f:
            self.assertTrue(json.load(f)["track_revisions"])

    def test_cancel_stops_remaining_files(self) -> None:
        import threading

        for i in range(5):
            self.doc(f"{i}.docx", [["생산 관리자"]])

        cancel = threading.Event()
        processed = []
        original = wp.BatchJob._process_file

        def counting(self_, path):
            processed.append(path)
            if len(processed) == 2:
                cancel.set()
            return original(self_, path)

        wp.BatchJob._process_file = counting
        try:
            job = wp.BatchJob(
                self.folder, False, [rule("생산 관리자", "생산 관리감독자")],
                cancel_event=cancel,
            )
            result = job.run()
        finally:
            wp.BatchJob._process_file = original

        self.assertTrue(result.cancelled)
        self.assertEqual(len(processed), 2)
        self.assertEqual(result.total_files, 2)

    def test_progress_callback_reports_each_file(self) -> None:
        for i in range(3):
            self.doc(f"파일{i}.docx", [["생산 관리자"]])
        events = []
        job = wp.BatchJob(
            self.folder, False, [rule("생산 관리자", "생산 관리감독자")],
            progress_cb=lambda i, t, n: events.append((i, t, n)),
        )
        job.run()
        self.assertEqual([e[0] for e in events], [1, 2, 3])
        self.assertEqual({e[1] for e in events}, {3})
        self.assertEqual([e[2] for e in events], ["파일0.docx", "파일1.docx", "파일2.docx"])


class LogWriteTest(BatchJobTestBase):
    def test_write_log_creates_file(self) -> None:
        self.doc("A.docx", [["생산 관리자"]])
        result = self.run_job([rule("생산 관리자", "생산 관리감독자")])
        log_path = wp.write_log(result)
        self.assertTrue(log_path)
        self.assertTrue(os.path.isfile(log_path))
        content = Path(log_path).read_text(encoding="utf-8")
        self.assertIn("[SOP Word 일괄변경]", content)
        self.assertIn("총 치환: 1", content)
        os.remove(log_path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
