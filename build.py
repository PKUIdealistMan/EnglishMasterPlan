#!/usr/bin/env python3
"""Inline src/style.css and src/js/*.js into single-file HTML pages under dist/.

usage: python3 build.py            # builds dist/kouyu.html (full app)
       python3 build.py probe      # builds dist/kouyu.html from the M0 probe shell
"""
import pathlib, sys

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "src"
COMMON = ["consts.js", "platform.js", "util.js", "audio.js", "probe.js"]
TARGETS = {
    "app": ("app.html", COMMON + ["data.js", "practice.js", "record.js", "dash.js", "pocket.js", "settings.js", "main.js"]),
    "probe": ("probe.html", COMMON + ["probe_main.js"]),
}

def build(target):
    shell, parts = TARGETS[target]
    css = (SRC / "style.css").read_text()
    js = "\n".join(f"/* ---- {p} ---- */\n" + (SRC / "js" / p).read_text() for p in parts)
    js = "'use strict';\n" + js
    if "</script" in js.lower() or "<!--" in js:
        raise SystemExit("inline JS must not contain '</script' or '<!--' (escape as '<\\/script')")
    html = (SRC / shell).read_text().replace("/*__CSS__*/", css).replace("/*__JS__*/", js)
    out = ROOT / "dist" / "kouyu.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html)
    (ROOT / "dist" / "kouyu.js").write_text(js)  # for `node --check`
    print(f"{target}: {out} ({len(html.encode()) // 1024} KB)")

if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else "app")
