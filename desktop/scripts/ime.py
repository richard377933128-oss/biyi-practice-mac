#!/usr/bin/env python3
"""macOS 输入法切换：current | select-english | select <id>

网页调试也可起本地代理：
  python3 ime.py --listen 8765
  POST /__pte/ime-english
  POST /__pte/ime-restore
"""

from __future__ import annotations

import json
import sys
import ctypes
import ctypes.util
from ctypes import c_void_p, c_bool, c_uint32, c_int, c_char_p
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

carbon = ctypes.CDLL(ctypes.util.find_library("Carbon"))
cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))

cf.CFStringCreateWithCString.argtypes = [c_void_p, c_char_p, c_uint32]
cf.CFStringCreateWithCString.restype = c_void_p
cf.CFStringGetCString.argtypes = [c_void_p, c_char_p, c_int, c_uint32]
cf.CFStringGetCString.restype = c_bool
cf.CFArrayGetCount.argtypes = [c_void_p]
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetValueAtIndex.argtypes = [c_void_p, ctypes.c_long]
cf.CFArrayGetValueAtIndex.restype = c_void_p

carbon.TISCreateInputSourceList.argtypes = [c_void_p, c_bool]
carbon.TISCreateInputSourceList.restype = c_void_p
carbon.TISGetInputSourceProperty.argtypes = [c_void_p, c_void_p]
carbon.TISGetInputSourceProperty.restype = c_void_p
carbon.TISSelectInputSource.argtypes = [c_void_p]
carbon.TISSelectInputSource.restype = c_int
carbon.TISCopyCurrentKeyboardInputSource.restype = c_void_p

kCFStringEncodingUTF8 = 0x08000100
PROP_ID = cf.CFStringCreateWithCString(None, b"TISPropertyInputSourceID", kCFStringEncodingUTF8)

ENGLISH_IDS = (
    "com.apple.keylayout.ABC",
    "com.apple.keylayout.US",
    "com.apple.keylayout.British",
    "com.apple.keylayout.Australian",
    "com.apple.keylayout.Canadian",
    "com.apple.keylayout.USInternational-PC",
    "com.apple.keylayout.Irish",
)


def cf_to_str(ref) -> str | None:
    if not ref:
        return None
    buf = ctypes.create_string_buffer(512)
    if cf.CFStringGetCString(ref, buf, 512, kCFStringEncodingUTF8):
        return buf.value.decode()
    return None


def current_id() -> str | None:
    src = carbon.TISCopyCurrentKeyboardInputSource()
    return cf_to_str(carbon.TISGetInputSourceProperty(src, PROP_ID))


def select_id(target: str) -> bool:
    lst = carbon.TISCreateInputSourceList(None, False)
    if not lst:
        return False
    n = cf.CFArrayGetCount(lst)
    for i in range(n):
        src = cf.CFArrayGetValueAtIndex(lst, i)
        sid = cf_to_str(carbon.TISGetInputSourceProperty(src, PROP_ID))
        if sid == target:
            return carbon.TISSelectInputSource(src) == 0
    return False


def is_english(sid: str | None) -> bool:
    if not sid:
        return False
    if sid in ENGLISH_IDS:
        return True
    return bool(
        sid.startswith("com.apple.keylayout.")
        and "Pinyin" not in sid
        and "Chinese" not in sid
    )


def select_english() -> str:
    cur = current_id() or ""
    if is_english(cur):
        return cur
    for eid in ENGLISH_IDS:
        if select_id(eid):
            return eid
    return ""


saved_input_source_id: str | None = None


def select_english_http() -> dict:
    global saved_input_source_id
    cur = current_id() or ""
    if is_english(cur):
        return {"ok": True, "already": True, "id": cur}
    if not saved_input_source_id:
        saved_input_source_id = cur
    chosen = select_english()
    ok = is_english(chosen) or is_english(current_id())
    return {"ok": ok, "id": chosen or current_id() or ""}


def restore_input_http() -> dict:
    global saved_input_source_id
    prev = saved_input_source_id
    saved_input_source_id = None
    if not prev:
        return {"ok": True, "skipped": True}
    ok = select_id(prev)
    return {"ok": ok, "id": prev}


def open_system_camera() -> dict:
    """打开 macOS 系统相机 / 照片Booth 录像。"""
    import shutil
    import subprocess

    if sys.platform != "darwin":
        return {"ok": False, "reason": "not-macos"}
    open_bin = shutil.which("open") or "/usr/bin/open"
    for app in ("Camera", "Photo Booth"):
        try:
            r = subprocess.run(
                [open_bin, "-a", app],
                check=False,
                capture_output=True,
                text=True,
                timeout=8,
            )
            if r.returncode == 0:
                return {"ok": True, "app": app}
        except Exception as err:  # noqa: BLE001
            last = str(err)
            continue
    return {"ok": False, "reason": "no-camera-app", "error": locals().get("last", "")}


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
            self._send(200, select_english_http())
            return
        if self.path.startswith("/__pte/ime-restore"):
            self._send(200, restore_input_http())
            return
        if self.path.startswith("/__pte/open-system-camera"):
            self._send(200, open_system_camera())
            return
        self._send(404, {"ok": False})

    def log_message(self, fmt: str, *args) -> None:
        return


def listen(port: int) -> int:
    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    except OSError:
        return 0
    print(f"ime proxy http://127.0.0.1:{port}/__pte/ime-english", flush=True)
    httpd.serve_forever()
    return 0


def main() -> int:
    if "--listen" in sys.argv:
        i = sys.argv.index("--listen")
        port = int(sys.argv[i + 1]) if i + 1 < len(sys.argv) else 8765
        return listen(port)
    if len(sys.argv) < 2:
        print(
            "usage: ime.py current|select-english|select <id>|open-camera|--listen [port]",
            file=sys.stderr,
        )
        return 2
    cmd = sys.argv[1]
    if cmd == "current":
        print(current_id() or "")
        return 0
    if cmd == "select-english":
        chosen = select_english()
        print(chosen)
        return 0 if is_english(current_id()) else 1
    if cmd == "open-camera":
        res = open_system_camera()
        print(json.dumps(res, ensure_ascii=False))
        return 0 if res.get("ok") else 1
    if cmd == "select" and len(sys.argv) >= 3:
        ok = select_id(sys.argv[2])
        print(sys.argv[2] if ok else "")
        return 0 if ok else 1
    print(
        "usage: ime.py current|select-english|select <id>|open-camera|--listen [port]",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
