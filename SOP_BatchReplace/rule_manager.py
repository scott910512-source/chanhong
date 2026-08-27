# -*- coding: utf-8 -*-
"""
SOP Word 일괄변경 도구 - 치환 규칙 관리 모듈

규칙 하나는 다음과 같은 구조를 가진다.

    {
        "enabled": true,
        "find": "생산 관리자",
        "replace": "생산 관리감독자"
    }

규칙은 리스트로 관리하며, 리스트 순서가 곧 실제 치환 적용 순서다.
저장 파일은 %APPDATA%\\SOPBatchReplace\\rules.json 이며 UTF-8 로 기록한다.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

from app_paths import get_rules_path, get_settings_path

# Word 의 Find.Text 는 최대 255자까지만 허용한다.
MAX_FIND_LENGTH = 255
MAX_REPLACE_LENGTH = 255


class RuleError(Exception):
    """규칙 검증 실패(빈 값, 중복 등)를 알리는 예외."""


def make_rule(find: str, replace: str, enabled: bool = True) -> Dict[str, Any]:
    """규칙 dict 를 만든다. 값 검증은 RuleManager 쪽에서 수행한다."""
    return {"enabled": bool(enabled), "find": find, "replace": replace}


def normalize_rule(raw: Any) -> Optional[Dict[str, Any]]:
    """
    파일에서 읽은 임의의 값을 규칙 dict 로 정규화한다.
    형식이 맞지 않거나 '찾을 문구'가 비어 있으면 None 을 돌려준다.
    """
    if not isinstance(raw, dict):
        return None
    find = raw.get("find")
    if not isinstance(find, str) or find == "":
        return None
    replace = raw.get("replace", "")
    if not isinstance(replace, str):
        replace = str(replace)
    return {"enabled": bool(raw.get("enabled", True)), "find": find, "replace": replace}


class RuleManager:
    """치환 규칙의 로드/저장/추가/수정/삭제/순서변경을 담당한다."""

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path: Path = Path(path) if path else get_rules_path()
        self.rules: List[Dict[str, Any]] = []
        self.load()

    # ------------------------------------------------------------------
    # 파일 입출력
    # ------------------------------------------------------------------
    def load(self) -> List[Dict[str, Any]]:
        """
        rules.json 을 읽는다.
        파일이 없으면 빈 규칙 파일을 자동으로 만든다.
        파일이 깨져 있으면 규칙을 비운 상태로 시작한다(프로그램은 계속 동작).
        """
        if not self.path.exists():
            self.rules = []
            self.save()
            return self.rules

        try:
            with self.path.open("r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            # 손상된 설정 파일 때문에 프로그램이 못 뜨는 상황은 막는다.
            self.rules = []
            return self.rules

        # 리스트 형태와 {"rules": [...]} 형태를 모두 허용한다.
        if isinstance(data, dict):
            data = data.get("rules", [])
        if not isinstance(data, list):
            data = []

        rules: List[Dict[str, Any]] = []
        for raw in data:
            rule = normalize_rule(raw)
            if rule is not None:
                rules.append(rule)
        self.rules = rules
        return self.rules

    def save(self) -> None:
        """현재 규칙 목록을 rules.json 에 기록한다(원자적 교체)."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(self.rules, f, ensure_ascii=False, indent=2)
        tmp.replace(self.path)

    # ------------------------------------------------------------------
    # 조회
    # ------------------------------------------------------------------
    def __len__(self) -> int:
        return len(self.rules)

    def get(self, index: int) -> Dict[str, Any]:
        return self.rules[index]

    def enabled_rules(self) -> List[Dict[str, Any]]:
        """실제로 문서에 적용할 규칙(사용 ON)만 순서대로 돌려준다."""
        return [r for r in self.rules if r.get("enabled")]

    def find_duplicate_index(
        self, find: str, replace: str, skip_index: Optional[int] = None
    ) -> Optional[int]:
        """'찾을 문구 + 바꿀 문구'가 완전히 같은 규칙의 위치를 돌려준다."""
        for i, rule in enumerate(self.rules):
            if skip_index is not None and i == skip_index:
                continue
            if rule["find"] == find and rule["replace"] == replace:
                return i
        return None

    # ------------------------------------------------------------------
    # 검증
    # ------------------------------------------------------------------
    def _validate(self, find: str, replace: str, skip_index: Optional[int] = None) -> None:
        """규칙 값 검증. 문제가 있으면 RuleError 를 던진다."""
        if find is None or find.strip() == "":
            # '찾을 문구'는 비어 있을 수 없다. ('바꿀 문구'는 빈 값 허용 = 삭제)
            raise RuleError("'찾을 문구'는 비워 둘 수 없습니다.")
        if len(find) > MAX_FIND_LENGTH:
            raise RuleError(
                "'찾을 문구'가 너무 깁니다.\n"
                f"Word 는 최대 {MAX_FIND_LENGTH}자까지만 찾을 수 있습니다."
            )
        if len(replace) > MAX_REPLACE_LENGTH:
            raise RuleError(
                "'바꿀 문구'가 너무 깁니다.\n"
                f"Word 는 최대 {MAX_REPLACE_LENGTH}자까지만 바꿀 수 있습니다."
            )
        if self.find_duplicate_index(find, replace, skip_index) is not None:
            raise RuleError("동일한 치환 규칙이 이미 등록되어 있습니다.")

    # ------------------------------------------------------------------
    # 편집 (모든 편집은 즉시 파일에 저장된다)
    # ------------------------------------------------------------------
    def add(self, find: str, replace: str, enabled: bool = True) -> Dict[str, Any]:
        self._validate(find, replace)
        rule = make_rule(find, replace, enabled)
        self.rules.append(rule)
        self.save()
        return rule

    def update(self, index: int, find: str, replace: str, enabled: bool) -> Dict[str, Any]:
        self._validate(find, replace, skip_index=index)
        self.rules[index] = make_rule(find, replace, enabled)
        self.save()
        return self.rules[index]

    def delete(self, index: int) -> None:
        del self.rules[index]
        self.save()

    def toggle(self, index: int) -> bool:
        """사용 여부를 뒤집고 새 상태를 돌려준다."""
        new_value = not bool(self.rules[index].get("enabled"))
        self.rules[index]["enabled"] = new_value
        self.save()
        return new_value

    def set_all(self, enabled: bool) -> None:
        """전체 ON / 전체 OFF."""
        for rule in self.rules:
            rule["enabled"] = bool(enabled)
        self.save()

    def move(self, index: int, delta: int) -> int:
        """
        규칙을 위/아래로 이동하고 새 위치를 돌려준다.
        치환은 목록에 보이는 순서대로 적용되므로 순서 변경은 곧바로 저장한다.
        """
        new_index = index + delta
        if new_index < 0 or new_index >= len(self.rules):
            return index
        self.rules[index], self.rules[new_index] = self.rules[new_index], self.rules[index]
        self.save()
        return new_index


class AppSettings:
    """대상 폴더/하위 폴더 포함 여부 같은 사용자 편의 설정을 저장한다."""

    DEFAULTS: Dict[str, Any] = {"last_folder": "", "recursive": False}

    def __init__(self, path: Optional[Path] = None) -> None:
        self.path: Path = Path(path) if path else get_settings_path()
        self.data: Dict[str, Any] = dict(self.DEFAULTS)
        self.load()

    def load(self) -> Dict[str, Any]:
        if self.path.exists():
            try:
                with self.path.open("r", encoding="utf-8") as f:
                    loaded = json.load(f)
                if isinstance(loaded, dict):
                    self.data.update(loaded)
            except (OSError, json.JSONDecodeError, UnicodeDecodeError):
                pass  # 설정 파일이 깨져도 기본값으로 계속 진행
        return self.data

    def save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, indent=2)
        except OSError:
            pass  # 편의 설정 저장 실패는 치명적이지 않으므로 무시

    def get(self, key: str, default: Any = None) -> Any:
        return self.data.get(key, self.DEFAULTS.get(key, default))

    def set(self, key: str, value: Any) -> None:
        self.data[key] = value
        self.save()
