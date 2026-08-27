# -*- coding: utf-8 -*-
"""
SOP Word 일괄변경 도구 - Word 문서 처리 모듈

핵심 원칙
---------
* python-docx 를 쓰지 않는다. Microsoft Word COM(win32com) 의 Find/Replace 를
  그대로 사용하므로 사람이 Word 에서 Ctrl+H 로 '모두 바꾸기' 한 것과 동일하게
  동작한다. 글꼴/표/이미지/머리글/스타일 등 서식이 그대로 유지된다.
* 본문뿐 아니라 StoryRanges(표/머리글/바닥글/각주/미주/주석/텍스트 상자 등)를
  모두 순회하고, NextStoryRange 체인까지 따라간다.
* 이미 Word 에서 열려 있는 문서는 절대 건드리지 않고 SKIP 한다.
* 사용자가 띄워 둔 기존 Word 는 종료하지 않는다. 이 프로그램이 DispatchEx 로
  새로 만든 숨은 인스턴스만 Quit 한다.
* 실제 변경 전에 원본을 백업하고, 백업에 실패한 파일은 수정하지 않는다.

이 모듈의 파일 탐색/백업/로그 기능은 Windows 가 아니어도 동작하며,
COM 관련 기능만 Windows + Microsoft Word 환경을 필요로 한다.
"""

from __future__ import annotations

import os
import shutil
import threading
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

from app_paths import get_log_dir

# ----------------------------------------------------------------------
# pywin32 는 Windows 에서만 존재한다. 없더라도 import 자체는 실패하지 않게 한다.
# (규칙 편집 등 나머지 기능은 계속 쓸 수 있어야 하므로)
# ----------------------------------------------------------------------
try:  # pragma: no cover - Windows 전용
    import pythoncom  # type: ignore
    import win32com.client  # type: ignore
    from pywintypes import com_error  # type: ignore

    WIN32_AVAILABLE = True
except Exception:  # pragma: no cover - 개발/테스트 환경
    pythoncom = None  # type: ignore
    win32com = None  # type: ignore

    class com_error(Exception):  # type: ignore
        """pywin32 가 없는 환경에서 쓰는 대체 예외."""

    WIN32_AVAILABLE = False


# ----------------------------------------------------------------------
# 상수
# ----------------------------------------------------------------------
WORD_EXTENSIONS: Tuple[str, ...] = (".docx", ".docm", ".doc")

# 백업 폴더 이름에 붙는 표식. 다음 실행 때 백업본을 다시 대상으로 잡지 않도록
# 이 표식이 들어간 폴더는 탐색에서 제외한다.
BACKUP_MARKER = "_원본백업_"
BACKUP_DIR_KEYWORDS = ("backup", "백업")

# Word 상수 (win32com.client.constants 대신 값을 직접 쓴다 - 조기 바인딩 불필요)
WD_REPLACE_NONE = 0
WD_REPLACE_ALL = 2
WD_FIND_STOP = 0
WD_DO_NOT_SAVE_CHANGES = 0
MSO_AUTOMATION_SECURITY_FORCE_DISABLE = 3  # 매크로 실행 차단

# 암호가 걸린 문서에서 Word 가 암호 입력창을 띄우고 멈추는 것을 막기 위한 더미 암호.
# 잘못된 암호를 넘기면 Word 는 프롬프트 대신 오류를 발생시킨다.
DUMMY_PASSWORD = "\x01SOPBatchReplace\x01"

# 무한 루프 방지용 상한 (한 영역에서 같은 문구를 세는 최대 횟수)
MAX_MATCH_SCAN = 20000

# 처리 상태
STATUS_CHANGED = "changed"
STATUS_UNCHANGED = "unchanged"
STATUS_SKIPPED_OPEN = "skipped_open"
STATUS_SKIPPED_READONLY = "skipped_readonly"
STATUS_ERROR = "error"

STATUS_LABEL = {
    STATUS_CHANGED: "변경",
    STATUS_UNCHANGED: "변경 없음",
    STATUS_SKIPPED_OPEN: "SKIP(열려 있음)",
    STATUS_SKIPPED_READONLY: "SKIP(읽기 전용)",
    STATUS_ERROR: "오류",
}


# ----------------------------------------------------------------------
# 경로 유틸
# ----------------------------------------------------------------------
def normalize_path(path: str | os.PathLike[str]) -> str:
    """
    경로 비교용 정규화.
    대소문자를 무시하고(os.path.normcase) 절대경로로 만든다(os.path.abspath).
    한글 경로/파일명도 그대로 처리된다.
    """
    return os.path.normcase(os.path.abspath(str(path)))


def is_temp_word_file(name: str) -> bool:
    """~$ 로 시작하는 Word 임시(잠금) 파일인지 확인."""
    return name.startswith("~$")


def is_backup_dir_name(name: str) -> bool:
    """백업 폴더로 보이는 이름인지 확인 (탐색 제외 대상)."""
    if BACKUP_MARKER in name:
        return True
    lowered = name.lower()
    return any(keyword in lowered for keyword in BACKUP_DIR_KEYWORDS)


def has_word_extension(name: str) -> bool:
    """대상 확장자(.docx/.docm/.doc)인지 확인."""
    return os.path.splitext(name)[1].lower() in WORD_EXTENSIONS


def collect_word_files(folder: str | os.PathLike[str], recursive: bool = False) -> List[str]:
    """
    대상 폴더에서 Word 문서 목록을 수집한다.

    * 확장자: .docx / .docm / .doc
    * 제외: ~$ 로 시작하는 임시 파일, 백업 폴더 내부 파일
    * recursive=True 이면 하위 폴더까지 재귀 탐색
    """
    root = str(folder)
    found: List[str] = []

    if not os.path.isdir(root):
        return found

    for dirpath, dirnames, filenames in os.walk(root):
        # 백업/임시 폴더는 통째로 건너뛴다 (os.walk 의 dirnames 를 직접 잘라낸다)
        dirnames[:] = [d for d in dirnames if not is_backup_dir_name(d) and not d.startswith("~")]
        if not recursive:
            dirnames[:] = []

        for filename in filenames:
            if is_temp_word_file(filename):
                continue
            if not has_word_extension(filename):
                continue
            found.append(os.path.join(dirpath, filename))

    found.sort(key=lambda p: p.lower())
    return found


def is_read_only_file(path: str) -> bool:
    """파일이 읽기 전용인지(쓰기 권한이 없는지) 확인."""
    try:
        return not os.access(path, os.W_OK)
    except OSError:
        return True


# ----------------------------------------------------------------------
# 현재 Word 에서 열려 있는 문서 목록
# ----------------------------------------------------------------------
def list_open_documents() -> List[str]:
    """
    현재 실행 중인 Microsoft Word 에서 열려 있는 문서들의 전체 경로를 돌려준다.

    * Word 가 실행 중이 아니면 빈 목록을 돌려준다(새 Word 를 띄우지 않는다).
    * GetActiveObject 는 ROT(Running Object Table)에 등록된 기존 인스턴스만
      가져오므로, 사용자가 열어 둔 Word 를 그대로 조회할 수 있다.
    """
    if not WIN32_AVAILABLE:
        return []

    open_paths: List[str] = []
    try:
        word = win32com.client.GetActiveObject("Word.Application")
    except Exception:
        # Word 가 실행 중이 아님 -> 열려 있는 문서도 없음
        return []

    try:
        for doc in word.Documents:
            try:
                full_name = doc.FullName
            except Exception:
                continue
            # 아직 저장하지 않은 새 문서는 경로가 없으므로 건너뛴다.
            if full_name and os.path.dirname(full_name):
                open_paths.append(full_name)
    except Exception:
        pass
    finally:
        # 사용자의 Word 인스턴스이므로 절대 Quit 하지 않는다. 참조만 버린다.
        word = None

    return open_paths


def open_document_key_set() -> set:
    """열려 있는 문서 경로를 정규화한 집합으로 돌려준다(빠른 비교용)."""
    return {normalize_path(p) for p in list_open_documents()}


# ----------------------------------------------------------------------
# 백업
# ----------------------------------------------------------------------
def make_backup_root(target_folder: str, timestamp: Optional[str] = None) -> str:
    """
    백업 폴더 경로를 만든다.

        C:\\SOP\\생산절차서  ->  C:\\SOP\\생산절차서_원본백업_20260827_143500

    대상 폴더가 드라이브 루트라 형제 폴더를 만들 수 없으면
    대상 폴더 안쪽에 백업 폴더를 만든다.
    """
    stamp = timestamp or datetime.now().strftime("%Y%m%d_%H%M%S")
    target = os.path.abspath(target_folder)
    parent = os.path.dirname(target)
    base = os.path.basename(target)

    if not base or not parent or normalize_path(parent) == normalize_path(target):
        # 드라이브 루트 등 예외적인 경우
        return os.path.join(target, f"{BACKUP_MARKER.strip('_')}_{stamp}")

    return os.path.join(parent, f"{base}{BACKUP_MARKER}{stamp}")


def backup_file(src: str, source_root: str, backup_root: str) -> str:
    """
    원본 파일 하나를 백업 폴더로 복사한다(원래의 하위 폴더 구조 유지).
    실패 시 예외를 그대로 올려서 호출측이 해당 파일을 SKIP 하게 한다.
    """
    rel = os.path.relpath(src, source_root)
    dest = os.path.join(backup_root, rel)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    # copy2 로 수정시각 등 메타데이터까지 보존한다.
    shutil.copy2(src, dest)
    return dest


# ----------------------------------------------------------------------
# 결과 자료 구조
# ----------------------------------------------------------------------
@dataclass
class FileResult:
    """문서 한 개의 처리 결과."""

    path: str
    status: str
    counts: Dict[str, int] = field(default_factory=dict)  # "찾을 문구 -> 바꿀 문구": 건수
    total: int = 0
    message: str = ""

    @property
    def name(self) -> str:
        return os.path.basename(self.path)


@dataclass
class JobResult:
    """전체 작업 결과 요약."""

    preview: bool = False
    folder: str = ""
    recursive: bool = False
    backup_root: str = ""
    rules: List[Dict[str, Any]] = field(default_factory=list)
    results: List[FileResult] = field(default_factory=list)
    started_at: datetime = field(default_factory=datetime.now)
    ended_at: Optional[datetime] = None
    cancelled: bool = False
    fatal_error: str = ""

    # ---- 집계 ----------------------------------------------------------
    @property
    def total_files(self) -> int:
        return len(self.results)

    def _count(self, status: str) -> int:
        return sum(1 for r in self.results if r.status == status)

    @property
    def changed_files(self) -> int:
        return self._count(STATUS_CHANGED)

    @property
    def unchanged_files(self) -> int:
        return self._count(STATUS_UNCHANGED)

    @property
    def skipped_open_files(self) -> List[FileResult]:
        return [r for r in self.results if r.status == STATUS_SKIPPED_OPEN]

    @property
    def skipped_readonly_files(self) -> List[FileResult]:
        return [r for r in self.results if r.status == STATUS_SKIPPED_READONLY]

    @property
    def error_files(self) -> List[FileResult]:
        return [r for r in self.results if r.status == STATUS_ERROR]

    @property
    def total_replacements(self) -> int:
        return sum(r.total for r in self.results)

    def per_rule_counts(self) -> Dict[str, int]:
        """규칙별 발견/치환 건수 합계 (규칙 순서 유지)."""
        summary: Dict[str, int] = {rule_key(r): 0 for r in self.rules}
        for result in self.results:
            for key, value in result.counts.items():
                summary[key] = summary.get(key, 0) + value
        return summary


def rule_key(rule: Dict[str, Any]) -> str:
    """규칙을 사람이 읽을 수 있는 한 줄 문자열로 만든다."""
    return f"{rule['find']} -> {rule['replace']}"


# ----------------------------------------------------------------------
# Word Find 문자열 이스케이프
# ----------------------------------------------------------------------
def escape_find_text(text: str) -> str:
    """
    Word 의 Find/Replace 에서 '^' 는 특수 코드(^p, ^t ...)의 시작 문자다.
    사용자가 입력한 문구를 있는 그대로 찾고 바꾸기 위해 '^' 를 '^94'
    (캐럿 문자 자체를 뜻하는 Word 코드)로 바꿔 준다.
    """
    return text.replace("^", "^94")


# ----------------------------------------------------------------------
# Word COM 작업 본체
# ----------------------------------------------------------------------
class BatchJob:
    """
    Word 문서 일괄 치환 작업.

    반드시 run() 을 호출한 그 스레드 안에서 COM 초기화 -> Word 생성 ->
    문서 처리 -> Word 종료 -> COM 해제까지 모두 수행한다.
    (COM 아파트먼트 문제를 피하기 위해 GUI 스레드와 섞지 않는다.)
    """

    def __init__(
        self,
        folder: str,
        recursive: bool,
        rules: Sequence[Dict[str, Any]],
        preview: bool = False,
        progress_cb: Optional[Callable[[int, int, str], None]] = None,
        cancel_event: Optional[threading.Event] = None,
    ) -> None:
        self.folder = os.path.abspath(folder)
        self.recursive = recursive
        self.rules = [dict(r) for r in rules]
        self.preview = preview
        self.progress_cb = progress_cb
        self.cancel_event = cancel_event or threading.Event()

        self._word = None          # 이 프로그램이 만든 Word 인스턴스
        self._backup_root = ""

    # ------------------------------------------------------------------
    def _report(self, index: int, total: int, filename: str) -> None:
        if self.progress_cb:
            try:
                self.progress_cb(index, total, filename)
            except Exception:
                pass  # 진행 표시 실패가 작업을 막아서는 안 된다

    def _cancelled(self) -> bool:
        return self.cancel_event.is_set()

    # ------------------------------------------------------------------
    # Word 인스턴스 생성/종료
    # ------------------------------------------------------------------
    def _create_word(self):
        """
        전용 Word 인스턴스를 새로 만든다.

        DispatchEx 를 쓰는 이유: Dispatch 는 이미 실행 중인 사용자 Word 를
        재사용할 수 있어서, 종료 시 사용자의 Word 까지 닫힐 위험이 있다.
        DispatchEx 는 항상 새 프로세스를 띄우므로 안전하게 분리된다.
        """
        word = win32com.client.DispatchEx("Word.Application")
        word.Visible = False           # 화면에 띄우지 않는다
        word.DisplayAlerts = 0         # wdAlertsNone - 경고창으로 멈추지 않게
        try:
            # 매크로 자동 실행 차단 (.docm 대비)
            word.AutomationSecurity = MSO_AUTOMATION_SECURITY_FORCE_DISABLE
        except Exception:
            pass
        try:
            word.ScreenUpdating = False
            word.Options.CheckSpellingAsYouType = False
            word.Options.CheckGrammarAsYouType = False
            word.Options.ConfirmConversions = False
            word.Options.SaveInterval = 0          # 자동 복구 저장 끄기
            word.Options.UpdateLinksAtOpen = False  # 열 때 링크 업데이트 안 함
        except Exception:
            pass  # 옵션 설정 실패는 무시하고 진행
        return word

    def _quit_word(self) -> None:
        """이 프로그램이 만든 Word 인스턴스만 종료한다."""
        if self._word is None:
            return
        try:
            # 혹시 남아 있는 문서가 있으면 저장하지 않고 닫는다.
            try:
                while self._word.Documents.Count > 0:
                    self._word.Documents(1).Close(WD_DO_NOT_SAVE_CHANGES)
            except Exception:
                pass
            self._word.Quit(WD_DO_NOT_SAVE_CHANGES)
        except Exception:
            pass
        finally:
            self._word = None

    # ------------------------------------------------------------------
    # Story Range 순회
    # ------------------------------------------------------------------
    @staticmethod
    def _iter_story_ranges(doc):
        """
        문서의 모든 텍스트 영역(StoryRange)을 순회한다.

        doc.StoryRanges 는 본문/머리글/바닥글/각주/미주/주석/텍스트 상자 등
        각 종류의 '첫 번째' 영역만 담고 있다. 같은 종류의 나머지 영역
        (예: 구역별 머리글, 여러 개의 텍스트 상자)은 NextStoryRange 로
        연결되어 있으므로 체인을 끝까지 따라간다.
        """
        try:
            stories = list(doc.StoryRanges)
        except Exception:
            # StoryRanges 조회가 실패하면 최소한 본문만이라도 처리한다.
            try:
                stories = [doc.Content]
            except Exception:
                return

        for story in stories:
            current = story
            guard = 0
            while current is not None and guard < 5000:
                guard += 1
                yield current
                try:
                    current = current.NextStoryRange
                except Exception:
                    current = None

    # ------------------------------------------------------------------
    # 찾기 / 바꾸기
    # ------------------------------------------------------------------
    @staticmethod
    def _configure_find(find_obj, find_text: str, replace_text: str) -> None:
        """Find 객체를 '단순 텍스트 치환' 조건으로 초기화한다."""
        find_obj.ClearFormatting()
        find_obj.Replacement.ClearFormatting()
        find_obj.Text = escape_find_text(find_text)
        find_obj.Replacement.Text = escape_find_text(replace_text)
        find_obj.Forward = True
        find_obj.Wrap = WD_FIND_STOP     # 영역 끝에서 멈춤(다른 영역으로 넘어가지 않게)
        find_obj.Format = False          # 서식 조건 없이 텍스트만 비교
        find_obj.MatchCase = True        # 대소문자 구분 (DMA Cabinet 등 정확히)
        find_obj.MatchWholeWord = False
        find_obj.MatchWildcards = False
        find_obj.MatchSoundsLike = False
        find_obj.MatchAllWordForms = False

    def _count_in_story(self, story, find_text: str) -> int:
        """
        한 영역 안에서 문구가 몇 번 나오는지 센다(문서는 수정하지 않는다).
        Word 의 ReplaceAll 은 치환 횟수를 돌려주지 않으므로, 치환 직전에
        같은 조건으로 먼저 세어 두고 그 값을 건수로 사용한다.
        """
        try:
            story_end = story.End
            scan = story.Duplicate
        except Exception:
            return 0

        try:
            find_obj = scan.Find
            self._configure_find(find_obj, find_text, "")
        except Exception:
            return 0

        count = 0
        last_end = -1
        while count < MAX_MATCH_SCAN:
            try:
                found = bool(find_obj.Execute())
            except Exception:
                break
            if not found:
                break
            count += 1
            try:
                pos = scan.End
                if pos <= last_end or pos >= story_end:
                    break  # 진행이 없거나 영역 끝 -> 무한 루프 방지
                last_end = pos
                scan.SetRange(pos, story_end)
                # SetRange 이후 Find 조건이 초기화될 수 있으므로 다시 설정한다.
                find_obj = scan.Find
                self._configure_find(find_obj, find_text, "")
            except Exception:
                break
        return count

    def _replace_in_story(self, story, find_text: str, replace_text: str) -> bool:
        """한 영역에서 '모두 바꾸기'를 실행한다. 성공 여부를 돌려준다."""
        try:
            target = story.Duplicate
            find_obj = target.Find
            self._configure_find(find_obj, find_text, replace_text)
            find_obj.Execute(Replace=WD_REPLACE_ALL)
            return True
        except Exception:
            return False

    def _apply_rules_to_document(self, doc) -> Dict[str, int]:
        """
        문서 하나에 모든 규칙을 목록 순서대로 적용한다.
        규칙별 치환 건수를 돌려준다.

        규칙마다 (전체 영역 세기 -> 전체 영역 바꾸기) 를 수행하므로
        1번 규칙이 완전히 끝난 뒤 2번 규칙이 적용된다(요구사항 19).
        """
        counts: Dict[str, int] = {}

        for rule in self.rules:
            if self._cancelled():
                break
            find_text = rule["find"]
            replace_text = rule.get("replace", "")
            key = rule_key(rule)
            rule_total = 0

            for story in self._iter_story_ranges(doc):
                if self._cancelled():
                    break
                found = self._count_in_story(story, find_text)
                if found <= 0:
                    continue
                if self.preview:
                    # 사전 확인 모드에서는 절대 문서를 바꾸지 않는다.
                    rule_total += found
                    continue
                if self._replace_in_story(story, find_text, replace_text):
                    rule_total += found

            if rule_total:
                counts[key] = counts.get(key, 0) + rule_total

        return counts

    # ------------------------------------------------------------------
    # 문서 한 개 처리
    # ------------------------------------------------------------------
    def _open_document(self, path: str, read_only: bool):
        """
        Word 로 문서를 연다.

        * PasswordDocument 에 더미 암호를 넘겨서, 암호가 걸린 문서일 때
          입력창이 뜨는 대신 오류가 나도록 만든다(프로그램이 멈추지 않게).
        * AddToRecentFiles=False 로 사용자의 최근 문서 목록을 더럽히지 않는다.
        """
        return self._word.Documents.Open(
            FileName=path,
            ConfirmConversions=False,
            ReadOnly=read_only,
            AddToRecentFiles=False,
            PasswordDocument=DUMMY_PASSWORD,
            WritePasswordDocument=DUMMY_PASSWORD,
            Revert=False,
            Visible=False,
        )

    def _process_file(self, path: str) -> FileResult:
        """문서 한 개를 열어 치환하고 저장한다. 예외는 여기서 흡수한다."""
        doc = None
        original_track_revisions = None
        try:
            doc = self._open_document(path, read_only=self.preview)

            # Word 가 읽기 전용으로 열었으면(다른 사용자 잠금 등) 수정하지 않는다.
            if not self.preview:
                try:
                    if bool(doc.ReadOnly):
                        return FileResult(
                            path,
                            STATUS_SKIPPED_READONLY,
                            message="Word 가 읽기 전용으로 열었습니다.",
                        )
                except Exception:
                    pass

                # 변경 내용 추적이 켜져 있으면 치환이 '수정 표시'로 남는다.
                # 잠시 꺼 두고 저장 직전에 원래 값으로 되돌린다.
                try:
                    original_track_revisions = bool(doc.TrackRevisions)
                    doc.TrackRevisions = False
                except Exception:
                    original_track_revisions = None

            counts = self._apply_rules_to_document(doc)
            total = sum(counts.values())

            if self.preview:
                # 사전 확인: 저장하지 않고 닫는다.
                return FileResult(
                    path,
                    STATUS_CHANGED if total > 0 else STATUS_UNCHANGED,
                    counts=counts,
                    total=total,
                )

            # 추적 설정 복원
            if original_track_revisions is not None:
                try:
                    doc.TrackRevisions = original_track_revisions
                except Exception:
                    pass

            if total > 0:
                # Save() 는 원래 파일 형식(.doc / .docx / .docm)을 그대로 유지한다.
                doc.Save()
                return FileResult(path, STATUS_CHANGED, counts=counts, total=total)

            return FileResult(path, STATUS_UNCHANGED, counts=counts, total=0)

        except com_error as exc:  # Word 쪽 오류 (암호 문서, 손상 파일 등)
            return FileResult(path, STATUS_ERROR, message=describe_com_error(exc))
        except Exception as exc:
            return FileResult(path, STATUS_ERROR, message=f"{type(exc).__name__}: {exc}")
        finally:
            if doc is not None:
                try:
                    doc.Close(WD_DO_NOT_SAVE_CHANGES)
                except Exception:
                    pass

    # ------------------------------------------------------------------
    # 전체 실행
    # ------------------------------------------------------------------
    def run(self) -> JobResult:
        """
        작업 전체를 실행한다. 반드시 워커 스레드에서 호출할 것.
        COM 초기화/해제와 Word 인스턴스 생성/종료를 이 함수 안에서 끝낸다.
        """
        result = JobResult(
            preview=self.preview,
            folder=self.folder,
            recursive=self.recursive,
            rules=self.rules,
        )

        files = collect_word_files(self.folder, self.recursive)
        total = len(files)

        if not WIN32_AVAILABLE:
            result.fatal_error = (
                "pywin32 를 사용할 수 없습니다.\n"
                "Windows 에서 Microsoft Word 가 설치된 환경에서 실행해 주세요."
            )
            result.ended_at = datetime.now()
            return result

        if total == 0:
            result.ended_at = datetime.now()
            return result

        # 현재 사용자가 Word 로 열어 둔 문서 목록 (작업 시작 시점 기준)
        open_docs = open_document_key_set()

        # 실제 변경 모드에서만 백업 폴더를 준비한다.
        backup_root = ""
        if not self.preview:
            backup_root = make_backup_root(self.folder)
            try:
                os.makedirs(backup_root, exist_ok=True)
            except OSError as exc:
                result.fatal_error = f"백업 폴더를 만들 수 없습니다.\n{backup_root}\n{exc}"
                result.ended_at = datetime.now()
                return result
        self._backup_root = backup_root
        result.backup_root = backup_root

        pythoncom.CoInitialize()
        try:
            try:
                self._word = self._create_word()
            except Exception as exc:
                result.fatal_error = (
                    "Microsoft Word 를 실행할 수 없습니다.\n"
                    "Word 가 설치되어 있는지 확인해 주세요.\n\n"
                    f"{type(exc).__name__}: {exc}"
                )
                result.ended_at = datetime.now()
                return result

            for index, path in enumerate(files, start=1):
                if self._cancelled():
                    result.cancelled = True
                    break

                self._report(index, total, os.path.basename(path))

                # 1) Word 에서 열려 있는 문서는 무조건 SKIP
                if normalize_path(path) in open_docs:
                    result.results.append(
                        FileResult(
                            path,
                            STATUS_SKIPPED_OPEN,
                            message="Word 에서 현재 열려 있음",
                        )
                    )
                    continue

                # 2) 읽기 전용 파일은 SKIP (사전 확인에서는 읽기만 하므로 통과)
                if not self.preview and is_read_only_file(path):
                    result.results.append(
                        FileResult(
                            path,
                            STATUS_SKIPPED_READONLY,
                            message="파일이 읽기 전용입니다.",
                        )
                    )
                    continue

                # 3) 원본 백업 (실패하면 절대 수정하지 않는다)
                if not self.preview:
                    try:
                        backup_file(path, self.folder, backup_root)
                    except Exception as exc:
                        result.results.append(
                            FileResult(
                                path,
                                STATUS_ERROR,
                                message=f"백업 실패로 변경하지 않음: {exc}",
                            )
                        )
                        continue

                # 4) 치환 실행
                result.results.append(self._process_file(path))

        finally:
            # 예외가 나더라도 Word 프로세스가 남지 않게 한다.
            self._quit_word()
            try:
                pythoncom.CoUninitialize()
            except Exception:
                pass

        result.ended_at = datetime.now()
        return result


def describe_com_error(exc: Exception) -> str:
    """COM 오류를 사용자가 이해할 수 있는 한국어 문장으로 바꾼다."""
    text = str(exc)
    lowered = text.lower()
    if "password" in lowered or "암호" in text:
        return "암호가 설정된 문서입니다."
    if "read-only" in lowered or "읽기 전용" in text:
        return "파일이 읽기 전용입니다."
    if "cannot be found" in lowered or "not found" in lowered:
        return "파일을 찾을 수 없습니다."
    if "in use" in lowered or "사용 중" in text:
        return "다른 프로그램이 파일을 사용 중입니다."
    return f"Word 오류: {text}"


# ----------------------------------------------------------------------
# 로그
# ----------------------------------------------------------------------
def write_log(result: JobResult) -> str:
    """
    작업 결과를 %APPDATA%\\SOPBatchReplace\\logs\\YYYYMMDD_HHMMSS.log 로 남긴다.
    로그 저장에 실패해도 예외를 밖으로 던지지 않는다(작업 결과가 우선).
    """
    try:
        log_dir = get_log_dir()
        stamp = result.started_at.strftime("%Y%m%d_%H%M%S")
        suffix = "_사전확인" if result.preview else ""
        log_path = log_dir / f"{stamp}{suffix}.log"
        with log_path.open("w", encoding="utf-8") as f:
            f.write(build_log_text(result))
        return str(log_path)
    except Exception:
        return ""


def build_log_text(result: JobResult) -> str:
    """로그 파일 본문을 만든다."""
    lines: List[str] = []
    title = "[SOP Word 일괄변경 - 사전 확인]" if result.preview else "[SOP Word 일괄변경]"
    lines.append(title)
    lines.append("")
    lines.append(f"작업시작: {result.started_at.strftime('%Y-%m-%d %H:%M:%S')}")
    lines.append("")
    lines.append("대상폴더:")
    lines.append(result.folder)
    lines.append(f"하위 폴더 포함: {'예' if result.recursive else '아니오'}")
    lines.append("")
    lines.append("규칙:")
    for rule in result.rules:
        lines.append(rule_key(rule))
    lines.append("")
    lines.append("-" * 50)
    lines.append("")

    if result.fatal_error:
        lines.append("[작업 실패]")
        lines.append(result.fatal_error)
        lines.append("")
        lines.append("-" * 50)

    for item in result.results:
        if item.status == STATUS_CHANGED:
            lines.append("[변경]" if not result.preview else "[변경 예상]")
            lines.append(item.name)
            for key, value in item.counts.items():
                lines.append(f"{key} : {value}건")
        elif item.status == STATUS_UNCHANGED:
            lines.append("[변경 없음]")
            lines.append(item.name)
        elif item.status == STATUS_SKIPPED_OPEN:
            lines.append("[SKIP]")
            lines.append(item.name)
            lines.append("사유: Word에서 현재 열려 있음")
        elif item.status == STATUS_SKIPPED_READONLY:
            lines.append("[SKIP]")
            lines.append(item.name)
            lines.append(f"사유: {item.message or '읽기 전용 파일'}")
        else:
            lines.append("[오류]")
            lines.append(item.name)
            lines.append(f"사유: {item.message}")
        lines.append("")

    lines.append("-" * 50)
    lines.append("")
    lines.append(f"처리 파일: {result.total_files}")
    lines.append(f"변경 파일: {result.changed_files}")
    lines.append(f"변경 없음: {result.unchanged_files}")
    lines.append(f"SKIP(열려 있음): {len(result.skipped_open_files)}")
    lines.append(f"SKIP(읽기 전용): {len(result.skipped_readonly_files)}")
    lines.append(f"오류: {len(result.error_files)}")
    lines.append(f"총 치환: {result.total_replacements}")
    lines.append("")
    lines.append("규칙별 건수:")
    for key, value in result.per_rule_counts().items():
        lines.append(f"{key} : {value}건")
    lines.append("")
    if result.backup_root:
        lines.append("원본 백업:")
        lines.append(result.backup_root)
        lines.append("")
    if result.cancelled:
        lines.append("※ 사용자가 작업을 중단했습니다.")
        lines.append("")
    ended = result.ended_at or datetime.now()
    lines.append("작업종료:")
    lines.append(ended.strftime("%Y-%m-%d %H:%M:%S"))
    lines.append("")
    return "\n".join(lines)
