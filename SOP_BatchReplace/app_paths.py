# -*- coding: utf-8 -*-
"""
SOP Word 일괄변경 도구 - 설정/로그 경로 관리 모듈

Windows 에서는 아래 위치를 사용한다.

    %APPDATA%\\SOPBatchReplace\\rules.json      (치환 규칙)
    %APPDATA%\\SOPBatchReplace\\settings.json   (마지막 대상 폴더 등)
    %APPDATA%\\SOPBatchReplace\\logs\\          (작업 로그)

Windows 가 아닌 환경(개발/테스트용)에서는 ~/.SOPBatchReplace 를 사용한다.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

APP_NAME = "SOPBatchReplace"


def get_app_dir() -> Path:
    """설정 폴더(%APPDATA%\\SOPBatchReplace)를 돌려주고, 없으면 만든다."""
    appdata = os.environ.get("APPDATA")
    if appdata:
        base = Path(appdata) / APP_NAME
    else:
        # Windows 가 아니거나 APPDATA 가 없는 경우의 대체 경로
        base = Path.home() / ("." + APP_NAME)
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_rules_path() -> Path:
    """치환 규칙 파일 경로."""
    return get_app_dir() / "rules.json"


def get_settings_path() -> Path:
    """마지막 대상 폴더 등 사용자 편의 설정 파일 경로."""
    return get_app_dir() / "settings.json"


def get_log_dir() -> Path:
    """로그 폴더 경로. 없으면 만든다."""
    log_dir = get_app_dir() / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    return log_dir


def open_app_dir() -> None:
    """설정 폴더를 탐색기(또는 OS 기본 파일 관리자)로 연다."""
    path = str(get_app_dir())
    if sys.platform.startswith("win"):
        # Windows 탐색기로 열기
        os.startfile(path)  # type: ignore[attr-defined]
    elif sys.platform == "darwin":
        subprocess.Popen(["open", path])
    else:
        subprocess.Popen(["xdg-open", path])
