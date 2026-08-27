# -*- coding: utf-8 -*-
"""
SOP Word 일괄변경 도구 - GUI (tkinter)

업무용 프로그램답게 단순하게 구성한다.
    상단  : 치환 규칙 목록(Treeview) + 규칙 편집 버튼
    중단  : 대상 폴더 선택 + 하위 폴더 포함
    하단  : 사전 확인 / 일괄 변경 실행 / 진행 상황

Word COM 작업은 GUI 를 멈추지 않도록 워커 스레드에서 수행하고,
진행 상황은 Queue 를 통해 GUI 스레드로 전달한다.
"""

from __future__ import annotations

import os
import queue
import threading
import traceback
from typing import Any, Dict, List, Optional

import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from app_paths import get_app_dir, open_app_dir
from rule_manager import AppSettings, RuleError, RuleManager
import word_processor as wp

APP_TITLE = "SOP Word 일괄변경 도구"
WINDOW_SIZE = "900x600"
MIN_SIZE = (760, 540)


# ======================================================================
# 공통 - 스크롤 가능한 텍스트 창
# ======================================================================
class TextWindow(tk.Toplevel):
    """결과/상세 내용을 보여주는 읽기 전용 텍스트 창."""

    def __init__(self, parent: tk.Misc, title: str, content: str, size: str = "640x520") -> None:
        super().__init__(parent)
        self.title(title)
        self.geometry(size)
        self.transient(parent)

        frame = ttk.Frame(self, padding=8)
        frame.pack(fill=tk.BOTH, expand=True)

        text = tk.Text(frame, wrap=tk.NONE, font=("맑은 고딕", 10))
        yscroll = ttk.Scrollbar(frame, orient=tk.VERTICAL, command=text.yview)
        xscroll = ttk.Scrollbar(frame, orient=tk.HORIZONTAL, command=text.xview)
        text.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)

        text.grid(row=0, column=0, sticky="nsew")
        yscroll.grid(row=0, column=1, sticky="ns")
        xscroll.grid(row=1, column=0, sticky="ew")
        frame.rowconfigure(0, weight=1)
        frame.columnconfigure(0, weight=1)

        text.insert("1.0", content)
        text.configure(state=tk.DISABLED)

        ttk.Button(self, text="닫기", command=self.destroy).pack(pady=(0, 8))


# ======================================================================
# 규칙 추가/수정 대화상자
# ======================================================================
class RuleDialog(tk.Toplevel):
    """치환 규칙 하나를 입력받는 작은 창. 결과는 self.result 에 담긴다."""

    def __init__(
        self,
        parent: tk.Misc,
        title: str,
        find: str = "",
        replace: str = "",
        enabled: bool = True,
    ) -> None:
        super().__init__(parent)
        self.title(title)
        self.resizable(False, False)
        self.transient(parent)
        self.result: Optional[Dict[str, Any]] = None

        self.var_find = tk.StringVar(value=find)
        self.var_replace = tk.StringVar(value=replace)
        self.var_enabled = tk.BooleanVar(value=enabled)

        body = ttk.Frame(self, padding=12)
        body.pack(fill=tk.BOTH, expand=True)

        ttk.Label(body, text="찾을 문구:").grid(row=0, column=0, sticky="w", pady=(0, 2))
        entry_find = ttk.Entry(body, textvariable=self.var_find, width=52)
        entry_find.grid(row=1, column=0, sticky="ew", pady=(0, 10))

        ttk.Label(body, text="바꿀 문구:  (비워 두면 해당 문구를 삭제합니다)").grid(
            row=2, column=0, sticky="w", pady=(0, 2)
        )
        entry_replace = ttk.Entry(body, textvariable=self.var_replace, width=52)
        entry_replace.grid(row=3, column=0, sticky="ew", pady=(0, 10))

        ttk.Checkbutton(body, text="사용 (ON)", variable=self.var_enabled).grid(
            row=4, column=0, sticky="w", pady=(0, 12)
        )

        buttons = ttk.Frame(body)
        buttons.grid(row=5, column=0, sticky="e")
        ttk.Button(buttons, text="저장", command=self._on_save, width=10).pack(
            side=tk.LEFT, padx=(0, 6)
        )
        ttk.Button(buttons, text="취소", command=self._on_cancel, width=10).pack(side=tk.LEFT)

        body.columnconfigure(0, weight=1)

        self.bind("<Return>", lambda _e: self._on_save())
        self.bind("<Escape>", lambda _e: self._on_cancel())

        entry_find.focus_set()
        self.protocol("WM_DELETE_WINDOW", self._on_cancel)

        # 부모 창 가운데에 띄운다.
        self.update_idletasks()
        try:
            x = parent.winfo_rootx() + (parent.winfo_width() - self.winfo_width()) // 2
            y = parent.winfo_rooty() + (parent.winfo_height() - self.winfo_height()) // 3
            self.geometry(f"+{max(x, 0)}+{max(y, 0)}")
        except Exception:
            pass

        self.grab_set()
        self.wait_window(self)

    def _on_save(self) -> None:
        find = self.var_find.get()
        replace = self.var_replace.get()
        if find.strip() == "":
            messagebox.showwarning("입력 확인", "'찾을 문구'는 비워 둘 수 없습니다.", parent=self)
            return
        self.result = {
            "find": find,
            "replace": replace,
            "enabled": bool(self.var_enabled.get()),
        }
        self.destroy()

    def _on_cancel(self) -> None:
        self.result = None
        self.destroy()


# ======================================================================
# 메인 윈도우
# ======================================================================
class MainApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()

        self.title(APP_TITLE)
        self.geometry(WINDOW_SIZE)
        self.minsize(*MIN_SIZE)

        self.rule_manager = RuleManager()
        self.settings = AppSettings()

        # 작업 상태
        self.worker: Optional[threading.Thread] = None
        self.cancel_event = threading.Event()
        self.message_queue: "queue.Queue[tuple]" = queue.Queue()
        self.last_result: Optional[wp.JobResult] = None
        self.closing_after_job = False   # 작업이 끝나면 자동 종료할지 여부
        self.destroyed = False

        self.var_folder = tk.StringVar(value=self.settings.get("last_folder", ""))
        self.var_recursive = tk.BooleanVar(value=bool(self.settings.get("recursive", False)))
        self.var_status = tk.StringVar(value="대기 중")
        self.var_progress_text = tk.StringVar(value="")
        self.var_progress = tk.DoubleVar(value=0.0)

        self._build_ui()
        self._refresh_tree()

        self.protocol("WM_DELETE_WINDOW", self._on_close)
        self.after(100, self._poll_queue)

        if not wp.WIN32_AVAILABLE:
            self.after(
                300,
                lambda: messagebox.showwarning(
                    "환경 확인",
                    "pywin32(Word 제어 모듈)를 찾을 수 없습니다.\n\n"
                    "규칙 편집은 가능하지만 실제 Word 변경 작업은\n"
                    "Windows + Microsoft Word 환경에서만 동작합니다.\n\n"
                    "설치: pip install pywin32",
                    parent=self,
                ),
            )

    # ------------------------------------------------------------------
    # UI 구성
    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        style = ttk.Style(self)
        try:
            style.theme_use("vista")  # Windows 기본 느낌
        except tk.TclError:
            pass
        try:
            # 한글 폰트 깨짐 방지 (Windows 기본 한글 폰트)
            default_font = ("맑은 고딕", 9)
            style.configure(".", font=default_font)
            style.configure("Treeview", font=default_font, rowheight=24)
            style.configure("Treeview.Heading", font=("맑은 고딕", 9, "bold"))
        except tk.TclError:
            pass

        root = ttk.Frame(self, padding=10)
        root.pack(fill=tk.BOTH, expand=True)
        root.columnconfigure(0, weight=1)
        root.rowconfigure(1, weight=1)

        # ---- 제목줄 -----------------------------------------------------
        header = ttk.Frame(root)
        header.grid(row=0, column=0, sticky="ew", pady=(0, 6))
        header.columnconfigure(0, weight=1)
        ttk.Label(header, text=APP_TITLE, font=("맑은 고딕", 13, "bold")).grid(
            row=0, column=0, sticky="w"
        )
        ttk.Button(header, text="설정 폴더 열기", command=self._open_settings_folder).grid(
            row=0, column=1, sticky="e"
        )

        # ---- 규칙 목록 ---------------------------------------------------
        rules_frame = ttk.LabelFrame(root, text="치환 규칙  (위에서부터 순서대로 적용됩니다)", padding=8)
        rules_frame.grid(row=1, column=0, sticky="nsew")
        rules_frame.columnconfigure(0, weight=1)
        rules_frame.rowconfigure(0, weight=1)

        columns = ("enabled", "find", "replace")
        self.tree = ttk.Treeview(
            rules_frame, columns=columns, show="headings", selectmode="browse"
        )
        self.tree.heading("enabled", text="사용")
        self.tree.heading("find", text="찾을 문구")
        self.tree.heading("replace", text="바꿀 문구")
        self.tree.column("enabled", width=60, minwidth=50, anchor=tk.CENTER, stretch=False)
        self.tree.column("find", width=340, minwidth=140, anchor=tk.W, stretch=True)
        self.tree.column("replace", width=340, minwidth=140, anchor=tk.W, stretch=True)

        yscroll = ttk.Scrollbar(rules_frame, orient=tk.VERTICAL, command=self.tree.yview)
        xscroll = ttk.Scrollbar(rules_frame, orient=tk.HORIZONTAL, command=self.tree.xview)
        self.tree.configure(yscrollcommand=yscroll.set, xscrollcommand=xscroll.set)

        self.tree.grid(row=0, column=0, sticky="nsew")
        yscroll.grid(row=0, column=1, sticky="ns")
        xscroll.grid(row=1, column=0, sticky="ew")

        # OFF 규칙은 회색으로 흐리게 표시
        self.tree.tag_configure("off", foreground="#888888")

        self.tree.bind("<Double-1>", self._on_tree_double_click)
        self.tree.bind("<Button-1>", self._on_tree_click)
        self.tree.bind("<space>", lambda _e: self._toggle_selected())

        # ---- 규칙 버튼 ---------------------------------------------------
        rule_buttons = ttk.Frame(root)
        rule_buttons.grid(row=2, column=0, sticky="ew", pady=(8, 0))
        for text, command in (
            ("규칙 추가", self._add_rule),
            ("수정", self._edit_rule),
            ("삭제", self._delete_rule),
            ("전체 ON", lambda: self._set_all(True)),
            ("전체 OFF", lambda: self._set_all(False)),
            ("▲ 위로", lambda: self._move_rule(-1)),
            ("▼ 아래로", lambda: self._move_rule(1)),
        ):
            ttk.Button(rule_buttons, text=text, command=command, width=11).pack(
                side=tk.LEFT, padx=(0, 4)
            )
        ttk.Label(
            rule_buttons,
            text="※ '사용' 칸을 클릭하면 ON/OFF 가 바뀝니다.",
            foreground="#666666",
        ).pack(side=tk.LEFT, padx=(10, 0))

        # ---- 대상 폴더 ---------------------------------------------------
        folder_frame = ttk.LabelFrame(root, text="대상 폴더", padding=8)
        folder_frame.grid(row=3, column=0, sticky="ew", pady=(10, 0))
        folder_frame.columnconfigure(0, weight=1)

        ttk.Entry(folder_frame, textvariable=self.var_folder).grid(
            row=0, column=0, sticky="ew", padx=(0, 6)
        )
        ttk.Button(folder_frame, text="폴더 선택", command=self._choose_folder, width=12).grid(
            row=0, column=1
        )
        ttk.Checkbutton(
            folder_frame,
            text="하위 폴더 포함",
            variable=self.var_recursive,
            command=self._on_recursive_changed,
        ).grid(row=1, column=0, sticky="w", pady=(6, 0))

        # ---- 실행 버튼 ---------------------------------------------------
        action_frame = ttk.Frame(root)
        action_frame.grid(row=4, column=0, sticky="ew", pady=(10, 0))

        self.btn_preview = ttk.Button(
            action_frame, text="사전 확인", command=self._start_preview, width=18
        )
        self.btn_preview.pack(side=tk.LEFT, padx=(0, 8))

        self.btn_run = ttk.Button(
            action_frame, text="일괄 변경 실행", command=self._start_replace, width=20
        )
        self.btn_run.pack(side=tk.LEFT, padx=(0, 8))

        self.btn_cancel = ttk.Button(
            action_frame, text="작업 중단", command=self._cancel_job, width=12, state=tk.DISABLED
        )
        self.btn_cancel.pack(side=tk.LEFT, padx=(0, 8))

        self.btn_details = ttk.Button(
            action_frame,
            text="제외/오류 파일 보기",
            command=self._show_skip_details,
            width=20,
            state=tk.DISABLED,
        )
        self.btn_details.pack(side=tk.RIGHT)

        # ---- 진행 상황 ---------------------------------------------------
        status_frame = ttk.LabelFrame(root, text="현재 상태", padding=8)
        status_frame.grid(row=5, column=0, sticky="ew", pady=(10, 0))
        status_frame.columnconfigure(0, weight=1)

        ttk.Label(status_frame, textvariable=self.var_status).grid(row=0, column=0, sticky="w")
        ttk.Label(status_frame, textvariable=self.var_progress_text, foreground="#444444").grid(
            row=1, column=0, sticky="w", pady=(2, 4)
        )
        self.progress = ttk.Progressbar(
            status_frame, orient=tk.HORIZONTAL, mode="determinate",
            variable=self.var_progress, maximum=100.0
        )
        self.progress.grid(row=2, column=0, sticky="ew")

    # ------------------------------------------------------------------
    # 규칙 목록 표시
    # ------------------------------------------------------------------
    def _refresh_tree(self, select_index: Optional[int] = None) -> None:
        """규칙 목록을 다시 그린다. iid 는 규칙 인덱스 문자열을 쓴다."""
        self.tree.delete(*self.tree.get_children())
        for index, rule in enumerate(self.rule_manager.rules):
            enabled = bool(rule.get("enabled"))
            self.tree.insert(
                "",
                tk.END,
                iid=str(index),
                values=("ON" if enabled else "OFF", rule["find"], rule["replace"]),
                tags=() if enabled else ("off",),
            )
        if select_index is not None and 0 <= select_index < len(self.rule_manager):
            iid = str(select_index)
            self.tree.selection_set(iid)
            self.tree.focus(iid)
            self.tree.see(iid)

    def _selected_index(self) -> Optional[int]:
        selection = self.tree.selection()
        if not selection:
            return None
        try:
            return int(selection[0])
        except ValueError:
            return None

    def _require_selection(self) -> Optional[int]:
        index = self._selected_index()
        if index is None:
            messagebox.showinfo("선택 필요", "목록에서 규칙을 먼저 선택해 주세요.", parent=self)
        return index

    # ------------------------------------------------------------------
    # 규칙 편집
    # ------------------------------------------------------------------
    def _add_rule(self) -> None:
        if self._busy_guard():
            return
        dialog = RuleDialog(self, "규칙 추가")
        if not dialog.result:
            return
        try:
            self.rule_manager.add(
                dialog.result["find"], dialog.result["replace"], dialog.result["enabled"]
            )
        except RuleError as exc:
            messagebox.showwarning("규칙 추가", str(exc), parent=self)
            return
        self._refresh_tree(select_index=len(self.rule_manager) - 1)
        self._set_status("규칙을 추가했습니다.")

    def _edit_rule(self) -> None:
        if self._busy_guard():
            return
        index = self._require_selection()
        if index is None:
            return
        rule = self.rule_manager.get(index)
        dialog = RuleDialog(
            self, "규칙 수정", rule["find"], rule["replace"], bool(rule.get("enabled"))
        )
        if not dialog.result:
            return
        try:
            self.rule_manager.update(
                index,
                dialog.result["find"],
                dialog.result["replace"],
                dialog.result["enabled"],
            )
        except RuleError as exc:
            messagebox.showwarning("규칙 수정", str(exc), parent=self)
            return
        self._refresh_tree(select_index=index)
        self._set_status("규칙을 수정했습니다.")

    def _delete_rule(self) -> None:
        if self._busy_guard():
            return
        index = self._require_selection()
        if index is None:
            return
        if not messagebox.askyesno(
            "규칙 삭제", "선택한 치환 규칙을 삭제하시겠습니까?", parent=self
        ):
            return
        self.rule_manager.delete(index)
        self._refresh_tree(select_index=min(index, len(self.rule_manager) - 1))
        self._set_status("규칙을 삭제했습니다.")

    def _set_all(self, enabled: bool) -> None:
        if self._busy_guard():
            return
        if not len(self.rule_manager):
            return
        self.rule_manager.set_all(enabled)
        self._refresh_tree(select_index=self._selected_index())
        self._set_status(f"모든 규칙을 {'ON' if enabled else 'OFF'} 으로 바꿨습니다.")

    def _move_rule(self, delta: int) -> None:
        if self._busy_guard():
            return
        index = self._require_selection()
        if index is None:
            return
        new_index = self.rule_manager.move(index, delta)
        self._refresh_tree(select_index=new_index)

    def _toggle_selected(self) -> None:
        if self._busy_guard():
            return
        index = self._selected_index()
        if index is None:
            return
        self.rule_manager.toggle(index)
        self._refresh_tree(select_index=index)

    def _on_tree_click(self, event: tk.Event) -> None:
        """'사용' 칸을 클릭하면 ON/OFF 를 토글한다."""
        if self.tree.identify_region(event.x, event.y) != "cell":
            return
        if self.tree.identify_column(event.x) != "#1":
            return
        row_id = self.tree.identify_row(event.y)
        if not row_id:
            return
        if self._busy_guard():
            return
        try:
            index = int(row_id)
        except ValueError:
            return
        self.rule_manager.toggle(index)
        self._refresh_tree(select_index=index)

    def _on_tree_double_click(self, event: tk.Event) -> None:
        """'사용' 칸이 아닌 곳을 더블클릭하면 수정 창을 연다."""
        if self.tree.identify_column(event.x) == "#1":
            return
        if self.tree.identify_row(event.y):
            self._edit_rule()

    # ------------------------------------------------------------------
    # 폴더 / 설정
    # ------------------------------------------------------------------
    def _choose_folder(self) -> None:
        if self._busy_guard():
            return
        initial = self.var_folder.get() if os.path.isdir(self.var_folder.get()) else None
        folder = filedialog.askdirectory(
            title="SOP 문서가 들어 있는 폴더를 선택하세요", initialdir=initial, parent=self
        )
        if folder:
            folder = os.path.normpath(folder)
            self.var_folder.set(folder)
            self.settings.set("last_folder", folder)
            self._set_status("대상 폴더를 선택했습니다.")

    def _on_recursive_changed(self) -> None:
        self.settings.set("recursive", bool(self.var_recursive.get()))

    def _open_settings_folder(self) -> None:
        try:
            open_app_dir()
        except Exception as exc:
            messagebox.showerror(
                "설정 폴더 열기",
                f"설정 폴더를 열지 못했습니다.\n\n{get_app_dir()}\n\n{exc}",
                parent=self,
            )

    # ------------------------------------------------------------------
    # 작업 실행
    # ------------------------------------------------------------------
    def _is_busy(self) -> bool:
        return self.worker is not None and self.worker.is_alive()

    def _busy_guard(self) -> bool:
        """작업 중이면 안내하고 True 를 돌려준다."""
        if self._is_busy():
            messagebox.showinfo(
                "작업 중", "현재 Word 문서를 처리하고 있습니다.\n작업이 끝난 뒤에 사용해 주세요.",
                parent=self,
            )
            return True
        return False

    def _validate_before_run(self) -> Optional[tuple]:
        """실행 전 공통 검사. (폴더, 규칙목록, 파일목록) 을 돌려준다."""
        folder = self.var_folder.get().strip()
        if not folder:
            messagebox.showwarning("대상 폴더", "대상 폴더를 먼저 선택해 주세요.", parent=self)
            return None
        if not os.path.isdir(folder):
            messagebox.showwarning(
                "대상 폴더", f"폴더를 찾을 수 없습니다.\n\n{folder}", parent=self
            )
            return None

        rules = self.rule_manager.enabled_rules()
        if not rules:
            messagebox.showwarning(
                "치환 규칙", "사용(ON) 상태인 치환 규칙이 없습니다.", parent=self
            )
            return None

        files = wp.collect_word_files(folder, bool(self.var_recursive.get()))
        if not files:
            messagebox.showinfo(
                "대상 파일",
                "선택한 폴더에서 Word 문서(.docx/.docm/.doc)를 찾지 못했습니다.\n\n"
                "하위 폴더에 있다면 '하위 폴더 포함'을 체크해 주세요.",
                parent=self,
            )
            return None

        return folder, rules, files

    def _start_preview(self) -> None:
        if self._busy_guard():
            return
        checked = self._validate_before_run()
        if not checked:
            return
        folder, rules, files = checked
        self._launch_job(folder, rules, preview=True, total_files=len(files))

    def _start_replace(self) -> None:
        if self._busy_guard():
            return
        checked = self._validate_before_run()
        if not checked:
            return
        folder, rules, files = checked

        confirm = messagebox.askyesno(
            "일괄 변경 확인",
            f"{len(rules)}개의 치환 규칙을\n"
            f"{len(files)}개의 Word 문서에 적용합니다.\n\n"
            "원본 문서는 자동으로 백업됩니다.\n"
            "Word 에서 열려 있는 문서는 제외됩니다.\n\n"
            "계속하시겠습니까?",
            parent=self,
        )
        if not confirm:
            return

        self._launch_job(folder, rules, preview=False, total_files=len(files))

    def _launch_job(
        self, folder: str, rules: List[Dict[str, Any]], preview: bool, total_files: int
    ) -> None:
        """워커 스레드를 띄워서 Word 작업을 시작한다."""
        self.cancel_event = threading.Event()
        self.var_progress.set(0.0)
        self.var_progress_text.set(f"0 / {total_files}")
        self._set_status("사전 확인 중..." if preview else "일괄 변경 중...")
        self._set_running(True)

        recursive = bool(self.var_recursive.get())

        def progress_cb(index: int, total: int, filename: str) -> None:
            # 워커 스레드에서 호출된다. GUI 를 직접 건드리지 않고 큐로 넘긴다.
            self.message_queue.put(("progress", index, total, filename))

        def worker() -> None:
            try:
                job = wp.BatchJob(
                    folder=folder,
                    recursive=recursive,
                    rules=rules,
                    preview=preview,
                    progress_cb=progress_cb,
                    cancel_event=self.cancel_event,
                )
                # COM 초기화부터 Word 종료까지 전부 이 스레드 안에서 끝난다.
                result = job.run()
                log_path = wp.write_log(result)
                self.message_queue.put(("done", result, log_path))
            except Exception:
                self.message_queue.put(("failed", traceback.format_exc()))

        self.worker = threading.Thread(target=worker, daemon=True, name="SOPBatchWorker")
        self.worker.start()

    def _cancel_job(self) -> None:
        if not self._is_busy():
            return
        if messagebox.askyesno(
            "작업 중단",
            "현재 진행 중인 작업을 중단하시겠습니까?\n\n"
            "이미 처리된 문서는 그대로 저장되어 있습니다.",
            parent=self,
        ):
            self.cancel_event.set()
            self._set_status("중단 요청됨... 현재 문서 처리 후 멈춥니다.")

    def _set_running(self, running: bool) -> None:
        state = tk.DISABLED if running else tk.NORMAL
        self.btn_preview.configure(state=state)
        self.btn_run.configure(state=state)
        self.btn_cancel.configure(state=tk.NORMAL if running else tk.DISABLED)

    def _set_status(self, text: str) -> None:
        self.var_status.set(text)

    # ------------------------------------------------------------------
    # 워커 -> GUI 메시지 처리
    # ------------------------------------------------------------------
    def _poll_queue(self) -> None:
        try:
            while True:
                message = self.message_queue.get_nowait()
                kind = message[0]

                if kind == "progress":
                    _, index, total, filename = message
                    percent = (index / total * 100.0) if total else 0.0
                    self.var_progress.set(percent)
                    self.var_progress_text.set(
                        f"{index} / {total}   ({percent:.0f}%)   {filename}"
                    )

                elif kind == "done":
                    _, result, log_path = message
                    self._on_job_done(result, log_path)

                elif kind == "failed":
                    _, detail = message
                    self._set_running(False)
                    self._set_status("작업 실패")
                    self.var_progress.set(0.0)
                    self.worker = None
                    if self._maybe_close_after_job():
                        return
                    TextWindow(self, "작업 실패 상세", detail)

        except queue.Empty:
            pass
        finally:
            # 창이 이미 닫혔으면 다시 예약하지 않는다(TclError 방지).
            if not self.destroyed:
                try:
                    self.after(100, self._poll_queue)
                except tk.TclError:
                    self.destroyed = True

    def _on_job_done(self, result: wp.JobResult, log_path: str) -> None:
        self.worker = None
        self.last_result = result
        self._set_running(False)
        self.var_progress.set(100.0)
        self.btn_details.configure(state=tk.NORMAL)

        # 사용자가 '작업이 끝나면 종료'를 선택했다면 결과 창을 띄우지 않고 닫는다.
        # (결과는 로그 파일에 이미 저장되어 있다.)
        if self._maybe_close_after_job():
            return

        if result.fatal_error:
            self._set_status("작업 실패")
            messagebox.showerror("작업 실패", result.fatal_error, parent=self)
            return

        if result.preview:
            self._set_status("사전 확인 완료")
        elif result.cancelled:
            self._set_status("작업 중단됨")
        else:
            self._set_status("일괄 변경 완료")

        self.var_progress_text.set(f"{result.total_files} / {result.total_files}   (100%)")
        TextWindow(
            self,
            "검사 결과" if result.preview else "일괄 변경 완료",
            self._build_summary(result, log_path),
        )

    def _build_summary(self, result: wp.JobResult, log_path: str) -> str:
        """결과 요약 텍스트를 만든다."""
        lines: List[str] = []
        if result.preview:
            lines.append("검사 결과  (실제 파일은 변경하지 않았습니다)")
            lines.append("")
            lines.append(f"대상 Word 파일 : {result.total_files}개")
            lines.append(f"적용 규칙 : {len(result.rules)}개")
            lines.append("")
            lines.append(f"변경 예상 문서 : {result.changed_files}개")
            lines.append(f"변경 없음 : {result.unchanged_files}개")
            lines.append(f"열려 있어 제외 : {len(result.skipped_open_files)}개")
            lines.append(f"읽기 전용 제외 : {len(result.skipped_readonly_files)}개")
            lines.append(f"오류 : {len(result.error_files)}개")
            lines.append("")
            lines.append(f"예상 치환 횟수 : {result.total_replacements}회")
        else:
            lines.append("일괄 변경 완료")
            lines.append("")
            lines.append(f"전체 Word 파일 : {result.total_files}개")
            lines.append(f"변경된 파일 : {result.changed_files}개")
            lines.append(f"변경 없음 : {result.unchanged_files}개")
            lines.append(f"열려 있어 제외 : {len(result.skipped_open_files)}개")
            lines.append(f"읽기 전용 제외 : {len(result.skipped_readonly_files)}개")
            lines.append(f"오류 : {len(result.error_files)}개")
            lines.append("")
            lines.append(f"총 치환 횟수 : {result.total_replacements}회")

        lines.append("")
        lines.append("-" * 44)
        lines.append("규칙별 건수")
        lines.append("-" * 44)
        for key, value in result.per_rule_counts().items():
            lines.append(f"{key} : {value}건")

        if result.cancelled:
            lines.append("")
            lines.append("※ 사용자가 작업을 중단했습니다.")

        if result.backup_root:
            lines.append("")
            lines.append("원본 백업:")
            lines.append(result.backup_root)

        if log_path:
            lines.append("")
            lines.append("로그 파일:")
            lines.append(log_path)

        skipped = (
            len(result.skipped_open_files)
            + len(result.skipped_readonly_files)
            + len(result.error_files)
        )
        if skipped:
            lines.append("")
            lines.append(f"※ 제외/오류 파일 {skipped}개가 있습니다.")
            lines.append("  메인 화면의 [제외/오류 파일 보기] 버튼으로 확인하세요.")

        return "\n".join(lines)

    def _show_skip_details(self) -> None:
        """제외/오류 파일 상세 목록을 보여준다."""
        result = self.last_result
        if result is None:
            messagebox.showinfo(
                "제외/오류 파일", "아직 실행한 작업이 없습니다.", parent=self
            )
            return

        lines: List[str] = []

        def section(title: str, items: List[wp.FileResult], with_reason: bool) -> None:
            lines.append(f"[{title}]")
            lines.append("")
            if not items:
                lines.append("없음")
            for number, item in enumerate(items, start=1):
                lines.append(f"{number}. {item.name}")
                lines.append(f"   {item.path}")
                if with_reason and item.message:
                    lines.append(f"   → {item.message}")
            lines.append("")
            lines.append("-" * 44)
            lines.append("")

        section("열려 있어서 제외", result.skipped_open_files, False)
        section("읽기 전용으로 제외", result.skipped_readonly_files, True)
        section("오류", result.error_files, True)

        TextWindow(self, "제외 / 오류 파일", "\n".join(lines))

    # ------------------------------------------------------------------
    # 종료 처리
    # ------------------------------------------------------------------
    def _on_close(self) -> None:
        if self._is_busy():
            answer = messagebox.askyesnocancel(
                "종료 확인",
                "현재 Word 문서 처리 중입니다.\n\n"
                "[예]    작업을 중단하고 종료합니다.\n"
                "[아니오] 작업이 끝나면 자동으로 종료합니다.\n"
                "[취소]  종료하지 않습니다.",
                parent=self,
            )
            if answer is None:
                return
            if answer:
                self.cancel_event.set()
                self._set_status("중단 요청됨... 종료를 준비합니다.")
            self.closing_after_job = True
            return
        self.destroy()

    def _maybe_close_after_job(self) -> bool:
        """
        작업 중에 종료 요청을 받았다면 작업이 끝난 지금 종료한다.
        실제로 종료했으면 True 를 돌려준다.
        """
        if self.closing_after_job:
            self.destroy()
            return True
        return False

    def destroy(self) -> None:
        """종료 시 예약된 콜백이 더 이상 실행되지 않도록 표시한다."""
        self.destroyed = True
        try:
            super().destroy()
        except tk.TclError:
            pass


def run() -> None:
    """GUI 실행 진입점."""
    app = MainApp()
    app.mainloop()
