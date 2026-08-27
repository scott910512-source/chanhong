# -*- coding: utf-8 -*-
"""tkinter 가 없는 환경에서 gui.py 를 import 하기 위한 최소 대역 모듈 (테스트 전용)."""

BOTH = "both"
LEFT = "left"
RIGHT = "right"
END = "end"
NONE = "none"
VERTICAL = "vertical"
HORIZONTAL = "horizontal"
CENTER = "center"
W = "w"
DISABLED = "disabled"
NORMAL = "normal"


class TclError(Exception):
    pass


class Misc:
    pass


class Event:
    pass


class _Widget:
    def __init__(self, *args, **kwargs):
        pass

    def __getattr__(self, name):
        def _noop(*args, **kwargs):
            return None
        return _noop


class Tk(_Widget):
    pass


class Toplevel(_Widget):
    pass


class Text(_Widget):
    pass


class Frame(_Widget):
    pass


class _Var:
    def __init__(self, value=None, **kwargs):
        self._value = value

    def get(self):
        return self._value

    def set(self, value):
        self._value = value


class StringVar(_Var):
    def __init__(self, value="", **kwargs):
        super().__init__(value, **kwargs)


class BooleanVar(_Var):
    def __init__(self, value=False, **kwargs):
        super().__init__(bool(value), **kwargs)


class DoubleVar(_Var):
    def __init__(self, value=0.0, **kwargs):
        super().__init__(float(value), **kwargs)
