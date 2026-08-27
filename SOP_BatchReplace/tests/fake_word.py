# -*- coding: utf-8 -*-
"""
테스트용 가짜 Microsoft Word COM 계층.

실제 Word 없이 BatchJob 의 흐름(StoryRange 순회, Find/Replace, 저장, 백업,
SKIP 처리, 오류 격리)을 검증하기 위한 최소 구현이다.

문서 파일은 JSON 으로 저장한다.
    {"stories": [["본문 텍스트"], ["머리글", "머리글 텍스트상자"]], "error": null}
바깥 리스트 = StoryRange 종류, 안쪽 리스트 = NextStoryRange 체인.
"""

from __future__ import annotations

import json
from typing import Any, Dict, List, Optional


def unescape(text: str) -> str:
    """word_processor.escape_find_text 의 역변환 (^94 -> ^)."""
    return text.replace("^94", "^")


class FakeError(Exception):
    """가짜 com_error."""


class Holder:
    """스토리 하나의 텍스트를 담는 가변 컨테이너."""

    def __init__(self, text: str) -> None:
        self.text = text


class FakeReplacement:
    def __init__(self) -> None:
        self.Text = ""

    def ClearFormatting(self) -> None:
        pass


class FakeFind:
    def __init__(self, rng: "FakeRange") -> None:
        self.rng = rng
        self.Text = ""
        self.Replacement = FakeReplacement()
        self.Forward = True
        self.Wrap = 0
        self.Format = False
        self.MatchCase = True
        self.MatchWholeWord = False
        self.MatchWildcards = False
        self.MatchSoundsLike = False
        self.MatchAllWordForms = False

    def ClearFormatting(self) -> None:
        pass

    def Execute(self, Replace: int = 0) -> bool:
        holder = self.rng.holder
        text = holder.text
        start = self.rng._start
        end = self.rng.End
        target = unescape(self.Text)
        if not target:
            return False

        if Replace == 2:  # wdReplaceAll
            segment = text[start:end]
            if target not in segment:
                return False
            holder.text = text[:start] + segment.replace(target, unescape(self.Replacement.Text)) + text[end:]
            return True

        index = text.find(target, start)
        if index == -1 or index + len(target) > end:
            return False
        self.rng._start = index
        self.rng._end = index + len(target)
        return True


class FakeRange:
    def __init__(
        self,
        holder: Holder,
        start: int = 0,
        end: Optional[int] = None,
        is_story: bool = False,
        next_story: Optional["FakeRange"] = None,
    ) -> None:
        self.holder = holder
        self._start = start
        self._end = end
        self.is_story = is_story
        self._next = next_story
        self._find = FakeFind(self)

    @property
    def Start(self) -> int:
        return self._start

    @property
    def End(self) -> int:
        if self.is_story or self._end is None:
            return len(self.holder.text)
        return self._end

    @property
    def Find(self) -> FakeFind:
        return self._find

    @property
    def Duplicate(self) -> "FakeRange":
        return FakeRange(self.holder, self._start, self.End)

    def SetRange(self, start: int, end: int) -> None:
        self._start = start
        self._end = end

    @property
    def NextStoryRange(self) -> Optional["FakeRange"]:
        return self._next


class FakeDocument:
    def __init__(self, app: "FakeWordApp", path: str, data: Dict[str, Any], read_only: bool) -> None:
        self.app = app
        self.path = path
        self.ReadOnly = bool(read_only or data.get("read_only"))
        self.TrackRevisions = bool(data.get("track_revisions", False))
        self.FullName = path
        self.closed = False
        self.save_count = 0

        self.holders: List[List[Holder]] = [
            [Holder(t) for t in chain] for chain in data.get("stories", [])
        ]
        stories: List[FakeRange] = []
        for chain in self.holders:
            ranges = [FakeRange(h, is_story=True) for h in chain]
            for i in range(len(ranges) - 1):
                ranges[i]._next = ranges[i + 1]
            if ranges:
                stories.append(ranges[0])
        self.StoryRanges = stories
        self._data = data

    def Save(self) -> None:
        if self.ReadOnly:
            raise FakeError("This document is read-only.")
        self._data["stories"] = [[h.text for h in chain] for chain in self.holders]
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(self._data, f, ensure_ascii=False)
        self.save_count += 1

    def Close(self, save_changes: int = 0) -> None:
        if self.closed:
            return
        self.closed = True
        if self in self.app.documents:
            self.app.documents.remove(self)


class FakeOptions:
    def __setattr__(self, name: str, value: Any) -> None:
        object.__setattr__(self, name, value)


class FakeDocuments:
    def __init__(self, app: "FakeWordApp") -> None:
        self.app = app

    def __call__(self, index: int) -> FakeDocument:
        return self.app.documents[index - 1]

    @property
    def Count(self) -> int:
        return len(self.app.documents)

    def Open(self, **kwargs: Any) -> FakeDocument:
        path = kwargs["FileName"]
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as exc:
            raise FakeError(f"cannot be found: {exc}")

        error = data.get("error")
        if error == "password":
            raise FakeError("The password is incorrect.")
        if error:
            raise FakeError(error)

        doc = FakeDocument(self.app, path, data, read_only=bool(kwargs.get("ReadOnly")))
        self.app.documents.append(doc)
        self.app.opened_paths.append(path)
        return doc


class FakeWordApp:
    """DispatchEx("Word.Application") 이 돌려주는 객체의 대역."""

    instances: List["FakeWordApp"] = []

    def __init__(self) -> None:
        self.Visible = True
        self.DisplayAlerts = -1
        self.AutomationSecurity = 1
        self.ScreenUpdating = True
        self.Options = FakeOptions()
        self.documents: List[FakeDocument] = []
        self.opened_paths: List[str] = []
        self.quit_called = 0
        self.Documents = FakeDocuments(self)
        FakeWordApp.instances.append(self)

    def Quit(self, save_changes: int = 0) -> None:
        self.quit_called += 1


class FakePythoncom:
    def __init__(self) -> None:
        self.init_count = 0
        self.uninit_count = 0

    def CoInitialize(self) -> None:
        self.init_count += 1

    def CoUninitialize(self) -> None:
        self.uninit_count += 1


def write_doc(path: str, stories: List[List[str]], **extra: Any) -> None:
    """가짜 Word 문서 파일을 만든다."""
    data: Dict[str, Any] = {"stories": stories}
    data.update(extra)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)


def read_stories(path: str) -> List[List[str]]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)["stories"]


class FakeClient:
    """win32com.client 대역."""

    @staticmethod
    def DispatchEx(prog_id: str) -> FakeWordApp:
        if prog_id != "Word.Application":
            raise FakeError(f"unknown ProgID: {prog_id}")
        return FakeWordApp()

    @staticmethod
    def GetActiveObject(prog_id: str) -> FakeWordApp:
        raise FakeError("no running instance")


class FakeWin32com:
    """win32com 모듈 대역."""

    client = FakeClient
