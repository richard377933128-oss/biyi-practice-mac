#!/usr/bin/env python3
"""Windows：把当前窗口切到英文键盘，离开后再切回来。

  python ime-win.py --listen 8765
  POST /__pte/ime-english
  POST /__pte/ime-restore
"""

from __future__ import annotations

import json
import sys
from ctypes import wintypes
import ctypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

user32 = ctypes.WinDLL("user32", use_last_error=True)

WM_INPUTLANGCHANGEREQUEST = 0x0050
KLF_ACTIVATE = 0x00000001
ENGLISH_KLID = "00000409"

user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
user32.GetKeyboardLayout.argtypes = [wintypes.DWORD]
user32.GetKeyboardLayout.restype = wintypes.HKL
user32.LoadKeyboardLayoutW.argtypes = [wintypes.LPCWSTR, wintypes.UINT]
user32.LoadKeyboardLayoutW.restype = wintypes.HKL
user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user32.PostMessageW.restype = wintypes.BOOL

saved_hkl = None


def foreground():
    hwnd = user32.GetForegroundWindow()
    pid = wintypes.DWORD()
    tid = user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return hwnd, user32.GetKeyboardLayout(tid)


def is_english(hkl) -> bool:
    try:
        return (int(hkl) & 0x3FF) == 0x09
    except (TypeError, ValueError):
        return False


def apply_layout(hwnd, hkl) -> bool:
    if not hwnd or not hkl:
        return False
    return bool(user32.PostMessageW(hwnd, WM_INPUTLANGCHANGEREQUEST, 0, wintypes.LPARAM(int(hkl))))


def select_english() -> dict:
    global saved_hkl
    hwnd, hkl = foreground()
    if is_english(hkl):
        return {"ok": True, "already": True}
    if saved_hkl is None:
        saved_hkl = int(hkl)
    english = user32.LoadKeyboardLayoutW(ENGLISH_KLID, KLF_ACTIVATE)
    ok = apply_layout(hwnd, english)
    return {"ok": ok, "id": int(english) if english else 0}


def restore_input() -> dict:
    global saved_hkl
    prev = saved_hkl
    saved_hkl = None
    if not prev:
        return {"ok": True, "skipped": True}
    hwnd, _hkl = foreground()
    return {"ok": apply_layout(hwnd, prev), "id": int(prev)}


class Handler(BaseHTTPRequestHandler):
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        self._send(204, {})

    def do_POST(self) -> None:
        if self.path.startswith("/__pte/ime-english"):
            self._send(200, select_english())
            return
        if self.path.startswith("/__pte/ime-restore"):
            self._send(200, restore_input())
            return
        self._send(404, {"ok": False})

    def log_message(self, fmt: str, *args) -> None:
        return


def listen(port: int) -> int:
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        return 0
    httpd.serve_forever()
    return 0


def main() -> int:
    if "--listen" in sys.argv:
        i = sys.argv.index("--listen")
        port = int(sys.argv[i + 1]) if i + 1 < len(sys.argv) else 8765
        return listen(port)
    print("usage: ime-win.py --listen 8765", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
