"""설정 로딩 (data/settings.yaml 또는 settings.json)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .models import Asset

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DEFAULT_SETTINGS = DATA_DIR / "settings.yaml"
# 웹앱에서 바꾼 설정은 YAML 주석을 깨지 않도록 이 파일에 따로 저장하고 위에 덮어쓴다.
OVERRIDES_NAME = "settings.overrides.json"
DEFAULT_TRANSACTIONS = DATA_DIR / "transactions.csv"
DEFAULT_CACHE = DATA_DIR / "cache" / "quotes.json"
DEFAULT_OUT = ROOT / "web" / "dashboard.html"

# 리포트에서 쓰는 한글 라벨
DIMENSION_LABELS = {
    "country": "국가",
    "ticker": "종목",
    "sector": "섹터",
    "currency": "통화",
    "account": "계좌",
    "asset_class": "자산군",
    "tag": "태그",
}


class ConfigError(RuntimeError):
    pass


@dataclass
class TargetItem:
    key: str
    target: float | None = None
    min: float | None = None
    max: float | None = None
    tolerance: float | None = None  # 이 항목만 다른 허용오차를 쓸 때
    bypass: bool = False
    note: str = ""

    def band(self, tolerance: float) -> tuple[float | None, float | None]:
        """(하한, 상한). min/max 가 명시돼 있으면 그걸 쓰고, 없으면 target ± tolerance.

        항목 자체에 tolerance 가 있으면 그룹 기본값보다 우선한다.
        """
        if self.tolerance is not None:
            tolerance = self.tolerance
        lo = self.min
        hi = self.max
        if self.target is not None:
            if lo is None:
                lo = max(0.0, self.target - tolerance)
            if hi is None:
                hi = self.target + tolerance
        return lo, hi


@dataclass
class TargetGroup:
    dimension: str
    tolerance: float = 5.0
    enabled: bool = True
    items: dict[str, TargetItem] = field(default_factory=dict)


@dataclass
class BypassEntry:
    scope: str  # country | ticker | sector | ... | all
    key: str
    reason: str = ""
    until: str | None = None  # YYYY-MM-DD, 지나면 자동 해제

    def active(self, today) -> bool:
        if not self.until:
            return True
        try:
            import datetime as _dt

            return today <= _dt.date.fromisoformat(str(self.until))
        except ValueError:
            return True


@dataclass
class Settings:
    base_currency: str = "KRW"
    display_currency: str | None = None
    assets: dict[str, Asset] = field(default_factory=dict)
    targets: dict[str, TargetGroup] = field(default_factory=dict)
    rules: dict[str, Any] = field(default_factory=dict)
    bypass_enabled: bool = True
    bypass_entries: list[BypassEntry] = field(default_factory=list)
    provider_order: list[str] | None = None
    cache_ttl: int = 300
    timeout: float = 10.0
    raw: dict = field(default_factory=dict)

    def asset(self, ticker: str) -> Asset:
        a = self.assets.get(ticker)
        if a is None:
            # settings 에 없는 종목도 거래내역만으로 최소 동작하게 한다.
            a = Asset(ticker=ticker, name=ticker)
            self.assets[ticker] = a
        return a


def _load_raw(path: Path) -> dict:
    if not path.exists():
        alt = path.with_suffix(".json")
        if alt.exists():
            path = alt
        else:
            raise ConfigError(f"설정 파일을 찾을 수 없습니다: {path}")
    text = path.read_text(encoding="utf-8")
    if path.suffix in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except ImportError as e:
            raise ConfigError(
                "YAML 설정을 읽으려면 PyYAML 이 필요합니다. "
                "`pip install pyyaml` 하거나 settings.json 을 쓰세요."
            ) from e
        return yaml.safe_load(text) or {}
    return json.loads(text)


def deep_merge(base: dict, over: dict) -> dict:
    """중첩 dict 병합. 리스트/스칼라는 통째로 교체한다."""
    out = dict(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def overrides_path(settings_path: Path | str = DEFAULT_SETTINGS) -> Path:
    return Path(settings_path).parent / OVERRIDES_NAME


def load_settings(path: Path | str = DEFAULT_SETTINGS) -> Settings:
    raw = _load_raw(Path(path))
    ov = overrides_path(path)
    if ov.exists():
        try:
            raw = deep_merge(raw, json.loads(ov.read_text(encoding="utf-8")))
        except json.JSONDecodeError:
            pass
    s = Settings(raw=raw)
    s.base_currency = str(raw.get("base_currency", "KRW")).upper()
    s.display_currency = raw.get("display_currency")

    for ticker, meta in (raw.get("assets") or {}).items():
        meta = meta or {}
        s.assets[ticker] = Asset(
            ticker=ticker,
            name=meta.get("name", ticker),
            country=str(meta.get("country", "??")).upper(),
            currency=str(meta.get("currency", "USD")).upper(),
            exchange=meta.get("exchange", ""),
            sector=meta.get("sector", "기타"),
            asset_class=meta.get("asset_class", "주식"),
            tags=list(meta.get("tags") or []),
            symbols={k: str(v) for k, v in (meta.get("symbols") or {}).items()},
            note=meta.get("note", ""),
        )

    for dim, group in (raw.get("targets") or {}).items():
        group = group or {}
        tg = TargetGroup(
            dimension=dim,
            tolerance=float(group.get("tolerance", 5.0)),
            enabled=bool(group.get("enabled", True)),
        )
        for key, item in (group.get("items") or {}).items():
            item = item or {}
            tg.items[str(key)] = TargetItem(
                key=str(key),
                target=_opt_float(item.get("target")),
                min=_opt_float(item.get("min")),
                max=_opt_float(item.get("max")),
                tolerance=_opt_float(item.get("tolerance")),
                bypass=bool(item.get("bypass", False)),
                note=item.get("note", ""),
            )
        s.targets[dim] = tg

    s.rules = dict(raw.get("rules") or {})

    bp = raw.get("bypass") or {}
    s.bypass_enabled = bool(bp.get("enabled", True))
    for e in bp.get("entries") or []:
        s.bypass_entries.append(
            BypassEntry(
                scope=str(e.get("scope", "ticker")),
                key=str(e.get("key", "")),
                reason=e.get("reason", ""),
                until=e.get("until"),
            )
        )

    prov = raw.get("providers") or {}
    order = prov.get("order")
    s.provider_order = [str(x) for x in order] if order else None
    s.cache_ttl = int(prov.get("cache_ttl_seconds", 300))
    s.timeout = float(prov.get("timeout_seconds", 10))
    return s


def _opt_float(v) -> float | None:
    if v is None or v == "":
        return None
    return float(v)
