import urllib.request

for path in ("/__pte/ime-english", "/__pte/ime-restore"):
    req = urllib.request.Request(f"http://127.0.0.1:8765{path}", data=b"{}", method="POST")
    with urllib.request.urlopen(req, timeout=3) as r:
        print(path, r.status, r.read().decode("utf-8", "replace"))
