/* ===================== 音频工具：解码、粗测停顿、上传类型 ===================== */

const AudioTools = (() => {
  const REC_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const MAX_WRAP_BYTES = 15 * 1024 * 1024;

  async function decode(blob) {
    const buf = await blob.arrayBuffer();
    const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) throw new Error('no OfflineAudioContext');
    const ctx = new Ctx(1, 16000, 16000);
    const ab = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && typeof p.then === 'function') p.then(res, rej);
    });
    const ch = ab.numberOfChannels, len = ab.length;
    const mono = new Float32Array(len);
    for (let c = 0; c < ch; c++) {
      const d = ab.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / ch;
    }
    return { samples: mono, sr: ab.sampleRate, duration: ab.duration };
  }

  function frameDb(samples, sr, frameS = 0.02) {
    const f = Math.max(1, Math.round(sr * frameS));
    const n = Math.floor(samples.length / f);
    const db = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let j = i * f, e = j + f; j < e; j++) s += samples[j] * samples[j];
      db[i] = 20 * Math.log10(Math.sqrt(s / f) + 1e-9);
    }
    return db;
  }
  function pct(a, p) {
    if (!a.length) return -180;
    const s = Float32Array.from(a).sort();
    const i = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
    return s[i];
  }
  const r2 = x => Math.round(x * 100) / 100;

  function level(samples, sr) {
    const db = frameDb(samples, sr);
    const peak = pct(db, 95), floor = pct(db, 10);
    return { peakDb: Math.round(peak), floorDb: Math.round(floor), rangeDb: Math.round(peak - floor) };
  }

  /* §9 本地粗测：20 ms 帧，第 10 百分位作底噪，高 12 dB 算说话，3 帧多数表决，
     首尾说话之间连续静音 ≥ pauseSec 算一次停顿。仅作即时反馈。 */
  function roughPauses(samples, sr, pauseSec) {
    const frameS = 0.02;
    const db = frameDb(samples, sr, frameS);
    const n = db.length;
    if (n < 10) return null;
    const floor = pct(db, 10), loud = pct(db, 95);
    const raw = new Uint8Array(n);
    for (let i = 0; i < n; i++) raw[i] = db[i] > floor + 12 ? 1 : 0;
    const sp = new Uint8Array(n);
    for (let i = 0; i < n; i++) sp[i] = ((i > 0 ? raw[i - 1] : 0) + raw[i] + (i < n - 1 ? raw[i + 1] : 0)) >= 2 ? 1 : 0;
    const first = sp.indexOf(1), last = sp.lastIndexOf(1);
    const noisy = loud - floor < 15;
    if (first < 0) return { pauses: 0, longestPauseSec: 0, speakingRatio: 0, noisy };
    let pauses = 0, longest = 0, run = 0, speech = 0;
    for (let i = first; i <= last; i++) {
      if (sp[i]) {
        if (run * frameS >= pauseSec) { pauses++; longest = Math.max(longest, run * frameS); }
        run = 0; speech++;
      } else run++;
    }
    return { pauses, longestPauseSec: r2(longest), speakingRatio: r2(speech / (last - first + 1)), noisy };
  }

  /* 录制 mimeType / 文件 → 上传类型。其他格式用 base64 包成 text/plain。 */
  function uploadTypeFor(mime, name) {
    const m = (mime || '').toLowerCase();
    const ext = ((name || '').split('.').pop() || '').toLowerCase();
    if (m.startsWith('audio/webm') || m.startsWith('video/webm') || ext === 'webm') return { type: 'video/webm', wrap: false };
    if (m.startsWith('audio/mp4') || m.startsWith('video/mp4') || m === 'audio/x-m4a' || m === 'audio/m4a' || ext === 'm4a' || ext === 'mp4') return { type: 'video/mp4', wrap: false };
    return { type: 'text/plain', wrap: true };
  }
  function guessMime(name) {
    const ext = ((name || '').split('.').pop() || '').toLowerCase();
    return ({ m4a: 'audio/mp4', mp4: 'audio/mp4', webm: 'audio/webm', mp3: 'audio/mpeg', aac: 'audio/aac', amr: 'audio/amr', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', '3gp': 'audio/3gpp', flac: 'audio/flac' })[ext] || '';
  }

  function toBase64(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result).split(',')[1] || '');
      fr.onerror = () => rej(fr.error);
      fr.readAsDataURL(blob);
    });
  }
  function base64ToBlob(b64, type) {
    const bin = atob(b64.trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: type || 'application/octet-stream' });
  }

  function pickRecorderMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    return REC_TYPES.find(t => MediaRecorder.isTypeSupported(t)) || '';
  }

  /* 上传一段录音：按类型直传，unsupported_type 时改用 base64，store_unavailable 重试一次 */
  async function uploadRecording(blob, mime, name) {
    const plan = uploadTypeFor(mime, name);
    const wrapped = async () => {
      if (blob.size > MAX_WRAP_BYTES) throw { code: 'too_large', message: '原始文件超过 15 MB' };
      const b64 = await toBase64(blob);
      return { res: await withRetry(() => Platform.blobs.upload(new Blob([b64], { type: 'text/plain' }), 'text/plain')), uploadType: 'text/plain' };
    };
    if (plan.wrap) return wrapped();
    try {
      return { res: await withRetry(() => Platform.blobs.upload(blob, plan.type)), uploadType: plan.type };
    } catch (e) {
      if (e.code === 'unsupported_type') return wrapped();
      throw e;
    }
  }
  async function withRetry(fn) {
    try { return await fn(); } catch (e) {
      if (e.code !== 'store_unavailable') throw e;
      await sleep(1500);
      return fn();
    }
  }

  return { decode, level, roughPauses, uploadTypeFor, guessMime, toBase64, base64ToBlob, pickRecorderMime, uploadRecording, REC_TYPES, MAX_WRAP_BYTES };
})();
