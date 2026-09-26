"""Natural-sounding English audio for 口语特训, made with Kokoro v1.0 (sherpa-onnx).

Sentences are packed into "sprites": one .mp4 (AAC, mono) per group with a short
silence between sentences, plus a table of start/duration per sentence. One sprite
is one asset upload and one db document `audio/<spriteId>`:
    {assetId, createdAt, items: [{k, t, s, d, v, r}]}
    k = key (see audio_key), t = text, s = start sec, d = duration sec, v = voice, r = role
The page finds a sentence by its key and plays that slice.

usage:
  python3 speak.py todo <dump_dir> > todo.json      # sentences in the db that have no audio yet
  python3 speak.py synth todo.json <out_dir>        # writes <out_dir>/<spriteId>.mp4 + manifest.json
  python3 speak.py docs <out_dir>/manifest.json <ids.json> <docs_dir>
                                                    # ids.json = {"<spriteId>.mp4": "<assetId>", ...}
                                                    # writes one JSON per db doc: <docs_dir>/<spriteId>.json
  python3 speak.py say "Some text." [voice] out.mp4  # one-off sample

<dump_dir> is an ArtifactData `out_dir` dump: <dump_dir>/<collection>/<doc_id>.json for
nodes, turns, bank, audio and config (missing collections are fine).

env: KOKORO_DIR (model dir), FFMPEG (ffmpeg binary), TTS_THREADS (default 4)
"""
import datetime, glob, hashlib, json, os, subprocess, sys, tempfile
import numpy as np

KOKORO_DIR = os.environ.get("KOKORO_DIR", "/home/claude/speech/kokoro-multi-lang-v1_0")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
SR = 24000
LEAD, GAP = 0.25, 0.45           # silence before the first sentence / between sentences
MAX_SPRITE_SEC = 600             # keep each file well under the 20 MiB asset limit

# Default voices; config/app may override with {"voices": {"me": ..., "them": ..., "<personaId>": ...}}
VOICES = {
    "me": "af_heart",       # the learner's model sentences (natural, corrected, best answer, say)
    "them": "am_michael",   # the other person (questions, follow-ups, listening items)
    "staff": "bm_george",
    "linda": "af_sarah", "siobhan": "bf_emma", "jonas": "am_adam", "jiwoo": "af_nicole",
}


def norm(text):
    return " ".join(str(text).split())


def audio_key(text):
    """FNV-1a 32-bit over UTF-8 of the whitespace-normalized text. Must match audioKey() in the page."""
    h = 0x811C9DC5
    for b in norm(text).encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return "a%08x" % h


def load_dump(dump_dir, coll):
    out = []
    for f in sorted(glob.glob(os.path.join(dump_dir, coll, "*.json"))):
        d = json.load(open(f))
        data = d.get("data", d) if isinstance(d, dict) else d
        if isinstance(data, dict):
            data = dict(data)
            data.setdefault("id", d.get("id") or os.path.splitext(os.path.basename(f))[0])
            out.append(data)
    return out


def wanted(dump_dir):
    """(text, role, voiceKey, group) for every sentence the page can play."""
    items = []
    add = lambda text, role, vk, group: text and str(text).strip() and items.append((norm(text), role, vk, group))
    for n in load_dump(dump_dir, "nodes"):
        g = "node-" + n["id"]
        them = "staff" if n.get("track") == "service" else "them"
        add(n.get("main_q"), "them", them, g)
        for t in n.get("variants") or []: add(t, "them", them, g)
        for t in n.get("followups") or []: add(t, "them", them, g)
        for t in n.get("say") or []: add(t.replace("…", "..."), "me", "me", g)
        for l in n.get("listen") or []:
            if l.get("tts") is not False: add(l.get("en"), "them", "them", g)
    for b in load_dump(dump_dir, "bank"):
        add(b.get("best_en"), "me", "me", "bank")
        for c in b.get("chunks") or []: add(c.get("en"), "me", "me", "bank")
    nodes = {n["id"]: n for n in load_dump(dump_dir, "nodes")}
    for t in load_dump(dump_dir, "turns"):
        add(t.get("natural") or t.get("corrected"), "me", "me", "turns")
        add(t.get("ask_back_en"), "me", "me", "turns")
        node = nodes.get(t.get("nodeId")) or {}
        who = "staff" if node.get("track") == "service" else (t.get("partner") or t.get("persona") or "them")
        add(t.get("followup"), "them", who, "turns")
    return items


def cmd_todo(dump_dir):
    have = set()
    for a in load_dump(dump_dir, "audio"):
        for it in a.get("items") or []:
            have.add(it.get("k"))
    cfg = next((c for c in load_dump(dump_dir, "config") if c["id"] == "app"), {})
    voices = dict(VOICES, **(cfg.get("voices") or {}))
    seen, todo = set(), []
    for text, role, vk, group in wanted(dump_dir):
        k = audio_key(text)
        if k in have or k in seen:
            continue
        seen.add(k)
        todo.append({"k": k, "t": text, "r": role, "v": voices.get(vk) or voices[role], "g": group})
    json.dump(todo, sys.stdout, ensure_ascii=False, indent=1)
    print(f"\n{len(todo)} sentences need audio", file=sys.stderr)


_tts = {}
def tts(accent="us"):
    """One engine per accent: British voices (bf_/bm_) use the GB lexicon."""
    if accent not in _tts:
        import sherpa_onnx
        d = KOKORO_DIR
        cfg = sherpa_onnx.OfflineTtsConfig(
            model=sherpa_onnx.OfflineTtsModelConfig(
                kokoro=sherpa_onnx.OfflineTtsKokoroModelConfig(
                    model=f"{d}/model.onnx", voices=f"{d}/voices.bin", tokens=f"{d}/tokens.txt",
                    data_dir=f"{d}/espeak-ng-data", dict_dir=f"{d}/dict",
                    lexicon=f"{d}/lexicon-{'gb' if accent == 'gb' else 'us'}-en.txt"),
                num_threads=int(os.environ.get("TTS_THREADS", "4")), provider="cpu"),
            max_num_sentences=1)
        _tts[accent] = sherpa_onnx.OfflineTts(cfg)
    return _tts[accent]


_speakers = None
def speaker_id(voice):
    global _speakers
    if _speakers is None:
        import onnx  # only for reading the speaker table from model metadata
        m = onnx.load(f"{KOKORO_DIR}/model.onnx", load_external_data=False)
        meta = {p.key: p.value for p in m.metadata_props}
        _speakers = {name: i for i, name in enumerate(meta["speaker_names"].split(","))}
    return _speakers[voice]


def synth_one(text, voice):
    a = tts("gb" if voice.startswith("b") else "us").generate(text, sid=speaker_id(voice), speed=1.0)
    x = np.asarray(a.samples, dtype=np.float32)
    assert a.sample_rate == SR, a.sample_rate
    # trim leading/trailing near-silence so slices start promptly
    idx = np.flatnonzero(np.abs(x) > 0.01)
    if len(idx):
        x = x[max(0, idx[0] - int(0.03 * SR)): idx[-1] + int(0.08 * SR)]
    return x


def encode_mp4(samples, path):
    with tempfile.NamedTemporaryFile(suffix=".f32", delete=False) as f:
        f.write(np.clip(samples, -1, 1).astype(np.float32).tobytes())
        raw = f.name
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", raw,
                    "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", path], check=True)
    os.unlink(raw)


def cmd_synth(todo_path, out_dir):
    todo = json.load(open(todo_path))
    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.datetime.utcnow().strftime("%Y%m%d%H%M%S")
    groups = {}
    for it in todo:
        groups.setdefault(it["g"], []).append(it)
    files = []
    for g, its in groups.items():
        part, buf, items, t = 0, [np.zeros(int(LEAD * SR), np.float32)], [], LEAD
        def flush():
            nonlocal part, buf, items, t
            if not items:
                return
            sprite = f"{g}-{stamp}-{part}"
            encode_mp4(np.concatenate(buf), os.path.join(out_dir, sprite + ".mp4"))
            files.append({"file": sprite + ".mp4", "sprite": sprite, "items": items})
            print(f"{sprite}.mp4  {len(items)} sentences  {t:.0f}s", file=sys.stderr)
            part, buf, items, t = part + 1, [np.zeros(int(LEAD * SR), np.float32)], [], LEAD
        for it in its:
            x = synth_one(it["t"], it["v"])
            d = len(x) / SR
            items.append({"k": it["k"], "t": it["t"], "s": round(t, 3), "d": round(d, 3), "v": it["v"], "r": it["r"]})
            buf += [x, np.zeros(int(GAP * SR), np.float32)]
            t += d + GAP
            if t > MAX_SPRITE_SEC:
                flush()
        flush()
    for f in files:
        f["sha256"] = hashlib.sha256(open(os.path.join(out_dir, f["file"]), "rb").read()).hexdigest()
    json.dump({"files": files}, open(os.path.join(out_dir, "manifest.json"), "w"), ensure_ascii=False, indent=1)
    print(f"{sum(len(f['items']) for f in files)} sentences in {len(files)} files", file=sys.stderr)


def cmd_docs(manifest_path, ids_path, docs_dir):
    man = json.load(open(manifest_path))
    ids = json.load(open(ids_path))
    os.makedirs(docs_dir, exist_ok=True)
    now = datetime.datetime.utcnow().isoformat(timespec="seconds") + "Z"
    writes = []
    for f in man["files"]:
        doc = {"assetId": ids[f["file"]], "createdAt": now, "items": f["items"]}
        p = os.path.join(docs_dir, f["sprite"] + ".json")
        json.dump(doc, open(p, "w"), ensure_ascii=False)
        writes.append({"op": "set", "collection": "audio", "doc_id": f["sprite"], "file_path": os.path.abspath(p)})
    print(json.dumps(writes, ensure_ascii=False))


def cmd_say(text, voice, out):
    encode_mp4(synth_one(text, voice), out)


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == "todo":
        cmd_todo(a[1])
    elif a[0] == "synth":
        cmd_synth(a[1], a[2])
    elif a[0] == "docs":
        cmd_docs(a[1], a[2], a[3])
    elif a[0] == "say":
        cmd_say(a[1], a[2] if len(a) > 3 else VOICES["me"], a[-1])
    else:
        sys.exit(__doc__)
