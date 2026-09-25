"""Analyze one spoken English answer.

Outputs a near-verbatim transcript plus fluency data: word timings, speech rate,
pauses (with a punctuation hint; the caller decides mid-clause vs. boundary),
mean length of run, and low-confidence words (pronunciation / grammar-site flags).

usage: python3 analyze.py <audio file> [more files...]
  - any format ffmpeg can read (webm/opus, m4a/mp4, mp3, amr, wav ...)
  - a .txt file is treated as a base64-wrapped recording and decoded first
"""
import base64, json, math, os, subprocess, sys, tempfile
import numpy as np
import soundfile as sf
import sherpa_onnx

MODEL = os.environ.get("ASR_MODEL_DIR", "/home/claude/speech/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8")
FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
PAUSE_S = 0.5       # gap counted as a pause
LONG_PAUSE_S = 1.0  # gap counted as a long hesitation
LOW_CONF = 0.6      # min token probability below which a word is flagged
PUNCT = {",", ".", "?", "!"}

_rec = None
def recognizer():
    global _rec
    if _rec is None:
        _rec = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=f"{MODEL}/encoder.int8.onnx", decoder=f"{MODEL}/decoder.int8.onnx",
            joiner=f"{MODEL}/joiner.int8.onnx", tokens=f"{MODEL}/tokens.txt",
            model_type="nemo_transducer", num_threads=4)
    return _rec

def unwrap(path):
    """Decode a base64 text wrapper (used when the page could not upload webm/mp4)."""
    if not path.endswith(".txt"):
        return path, None
    raw = base64.b64decode(open(path, "rb").read().strip())
    tmp = tempfile.NamedTemporaryFile(suffix=".bin", delete=False)
    tmp.write(raw); tmp.close()
    return tmp.name, tmp.name

def to_wav16k(path):
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False).name
    subprocess.run([FFMPEG, "-y", "-loglevel", "error", "-i", path, "-ac", "1", "-ar", "16000", out], check=True)
    return out

def silences_from_energy(samples, sr, frame_s=0.02):
    """Silent stretches >= PAUSE_S between the first and last speech frame.

    Token durations from the recognizer spill into following silence, so gaps
    between words underestimate pauses (a real 0.68 s pause measured as 0.32 s).
    Frame energy is used instead. Returns None if the recording is too noisy.
    """
    f = int(frame_s * sr)
    n = len(samples) // f
    if n < 10:
        return None
    frames = samples[: n * f].reshape(n, f)
    db = 20 * np.log10(np.sqrt((frames ** 2).mean(axis=1)) + 1e-9)
    floor, loud = np.percentile(db, 10), np.percentile(db, 95)
    if loud - floor < 15:
        return None
    speech = db > floor + 12
    speech = np.convolve(speech.astype(int), [1, 1, 1], mode="same") >= 2  # 3-frame majority
    idx = np.flatnonzero(speech)
    if len(idx) == 0:
        return None
    out, start = [], None
    for i in range(idx[0], idx[-1] + 1):
        if not speech[i] and start is None:
            start = i
        elif speech[i] and start is not None:
            if (i - start) * frame_s >= PAUSE_S:
                out.append((start * frame_s, i * frame_s))
            start = None
    return out

def words_from(result):
    """Merge BPE tokens into words with start/end time and min-token confidence."""
    words = []
    for tok, t, dur, lp in zip(result.tokens, result.timestamps, result.durations, result.ys_log_probs):
        p = math.exp(lp)
        if tok.strip() in PUNCT:
            if words:
                words[-1]["w"] += tok.strip()
            continue
        if tok.startswith(" ") or not words:
            words.append({"w": tok.strip(), "s": t, "e": t + dur, "c": p})
        else:
            w = words[-1]
            w["w"] += tok
            w["e"] = t + dur
            w["c"] = min(w["c"], p)
    return words

def analyze(path):
    src, tmp_bin = unwrap(path)
    wav = to_wav16k(src)
    samples, sr = sf.read(wav, dtype="float32")
    os.unlink(wav)
    if tmp_bin:
        os.unlink(tmp_bin)
    s = recognizer().create_stream()
    s.accept_waveform(sr, samples)
    recognizer().decode_stream(s)
    r = s.result
    words = words_from(r)
    base = {"file": os.path.basename(path), "duration_s": round(len(samples) / sr, 1)}
    if not words:
        return {**base, "text": "", "note": "no speech recognized"}

    pauses, method = [], "energy"
    silences = silences_from_energy(samples, sr)
    if silences is None:  # too noisy for the energy method: fall back to gaps between words
        method = "word_gaps"
        silences = [(a["e"], b["s"]) for a, b in zip(words, words[1:]) if b["s"] - a["e"] >= PAUSE_S]
    for start, end in silences:
        center = (start + end) / 2
        # attach the silence to the word boundary it falls in
        i = max((k for k in range(len(words) - 1) if words[k]["s"] <= center), default=None)
        if i is None or center >= words[-1]["s"]:
            continue  # before the first word or after the last one
        a, b = words[i], words[i + 1]
        gap = end - start
        pauses.append({
            "after_index": i, "after": a["w"], "before": b["w"], "sec": round(gap, 2),
            # Hint only: the recognizer tends to insert punctuation AT pauses, so this
            # over-reports sentence boundaries. Decide mid-clause vs boundary from context.
            "after_punct": a["w"][-1] in PUNCT,
            "long": gap >= LONG_PAUSE_S,
        })
    span = words[-1]["e"] - words[0]["s"]
    paused = sum(p["sec"] for p in pauses)
    n = len(words)
    mid = [p for p in pauses if not p["after_punct"]]
    return {
        **base,
        "text": r.text.strip(),
        "words": [{"w": w["w"], "s": round(w["s"], 2), "e": round(w["e"], 2), "c": round(w["c"], 2)} for w in words],
        "n_words": n,
        "wpm": round(n / span * 60) if span > 0 else None,                       # speech rate
        "wpm_excl_pauses": round(n / (span - paused) * 60) if span > paused else None,  # articulation rate
        "pauses": pauses,
        "pause_method": method,
        "pauses_per_min": round(len(pauses) / span * 60, 1) if span > 0 else None,
        "pauses_not_after_punct": len(mid),   # lower bound on mid-clause hesitations
        "longest_pause_s": max((p["sec"] for p in pauses), default=0),
        "mean_length_of_run": round(n / (len(pauses) + 1), 1),                     # words between pauses
        "low_confidence": [{"index": i, "w": w["w"], "c": round(w["c"], 2), "s": round(w["s"], 2)}
                           for i, w in enumerate(words) if w["c"] < LOW_CONF],
    }

if __name__ == "__main__":
    for f in sys.argv[1:]:
        print(json.dumps(analyze(f), ensure_ascii=False, indent=1))
