"""표준 라이브러리만 쓰는 아주 얇은 HTTP 헬퍼.

외부 패키지 설치 없이도 동작하는 것이 목표. requests 가 있으면 쓰지 않고
urllib 로 통일해서 프록시/타임아웃 동작을 예측 가능하게 만든다.
"""

from __future__ import annotations

import csv as _csv
import gzip
import io
import json
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_TIMEOUT = 10.0
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0 Safari/537.36"
)


class FetchError(RuntimeError):
    pass


def fetch(url: str, params: dict | None = None, headers: dict | None = None,
          timeout: float = DEFAULT_TIMEOUT) -> str:
    """GET 요청 후 본문을 문자열로 반환. 실패하면 FetchError."""
    if params:
        url = f"{url}?{urllib.parse.urlencode(params)}"
    hdrs = {
        "User-Agent": UA,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
        "Accept-Encoding": "gzip, identity",
    }
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            if resp.headers.get("Content-Encoding") == "gzip":
                raw = gzip.decompress(raw)
            charset = resp.headers.get_content_charset() or "utf-8"
            return raw.decode(charset, errors="replace")
    except urllib.error.HTTPError as e:  # noqa: PERF203
        raise FetchError(f"HTTP {e.code} {url}") from e
    except Exception as e:  # 네트워크/TLS/프록시 차단 등
        raise FetchError(f"{type(e).__name__}: {e} ({url})") from e


def fetch_json(url: str, params: dict | None = None, headers: dict | None = None,
               timeout: float = DEFAULT_TIMEOUT):
    body = fetch(url, params=params, headers=headers, timeout=timeout)
    try:
        return json.loads(body)
    except json.JSONDecodeError as e:
        raise FetchError(f"JSON 파싱 실패: {url}") from e


def fetch_csv(url: str, params: dict | None = None, timeout: float = DEFAULT_TIMEOUT) -> list[dict]:
    body = fetch(url, params=params, timeout=timeout)
    return list(_csv.DictReader(io.StringIO(body)))
