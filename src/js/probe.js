/* =====================================================================
 * M0 探针：逐项测试设备和 artifact 能力，结果写入 probe/{ts}。
 * 正式页面里一直保留在"设置 → 诊断"。页面也用同一套结果决定录音方式。
 * ===================================================================== */

const Probe = (() => {
  const MR_TYPES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  const ITEMS = [
    { n: 1, key: 'gum',        title: '页面里获取麦克风', sub: 'getUserMedia' },
    { n: 2, key: 'recorder',   title: '页面里录 5 秒',     sub: 'MediaRecorder 格式与录音' },
    { n: 3, key: 'upload',     title: '上传页面录音',       sub: 'assets.upload，video/webm 或 video/mp4' },
    { n: 4, key: 'filePick',   title: '系统录音机或选文件', sub: '再以 base64 text/plain 上传', manual: true },
    { n: 5, key: 'sample',     title: '页面内 Claude',      sub: 'sample.json，quick 档' },
    { n: 6, key: 'tts',        title: '英文朗读语音',       sub: 'speechSynthesis.getVoices()' },
    { n: 7, key: 'asr',        title: '网页语音识别',       sub: 'webkitSpeechRecognition', manual: true },
    { n: 8, key: 'asrWithRec', title: '识别和录音同时进行', sub: 'MediaRecorder + 语音识别', manual: true },
    { n: 9, key: 'saved',      title: '写入数据库',         sub: 'probe/{ts}' },
  ];
  const STATUS = { pass: ['通过', 'ok'], fail: ['失败', 'high'], skip: ['跳过', ''], running: ['进行中', 'accent'], idle: ['未测', ''] };

  let R = null, docId = null, root = null, stream = null, recBlob = null, busy = false;
  let saveChain = Promise.resolve();

  const SR = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;

  function micPolicy() {
    try {
      const fp = document.permissionsPolicy || document.featurePolicy;
      return fp && fp.allowsFeature ? fp.allowsFeature('microphone') : null;
    } catch (_) { return null; }
  }
  function isFramed() { try { return window.top !== window.self; } catch (_) { return true; } }
  function device() {
    const ua = navigator.userAgent;
    const app = /Claude/i.test(ua) ? 'Claude App' : /wv\)/.test(ua) ? 'WebView' : /Chrome\//.test(ua) ? 'Chrome' : 'Browser';
    const kind = /Mobile/.test(ua) ? '手机' : /Android/.test(ua) ? '平板' : '电脑';
    return kind + ' · ' + app;
  }

  function fresh() {
    const ts = nowIso();
    docId = ts;
    R = {
      ts, ua: navigator.userAgent, device: device(), appVersion: APP_VERSION, startedAt: ts, updatedAt: ts,
      context: {
        hasClaude: Platform.hasClaude, db: Platform.store.available, assets: Platform.blobs.available,
        sample: Platform.llm.available, downloads: Platform.blobs.canSave,
        framed: isFramed(), secureContext: window.isSecureContext, micPolicy: micPolicy(),
        mediaDevices: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        mediaRecorder: typeof MediaRecorder !== 'undefined', speechRecognition: !!SR(),
        speechSynthesis: !!window.speechSynthesis,
        standalone: !!(window.matchMedia && matchMedia('(display-mode: standalone)').matches),
      },
      items: {},
    };
  }

  function set(key, val, save = true) {
    R.items[key] = val;
    renderItem(key);
    renderVerdict();
    if (save && val.status !== 'running') scheduleSave();
  }

  function scheduleSave() {
    saveChain = saveChain.then(async () => {
      const items = Object.assign({}, R.items); delete items.saved;
      R.updatedAt = nowIso();
      const doc = JSON.parse(JSON.stringify(Object.assign({}, R, { items })));
      remember(items);
      if (!Platform.store.available) { R.items.saved = { status: 'fail', message: '数据库不可用：需要在 Claude 的 artifact 查看器里打开' }; }
      else {
        try { await Platform.store.set('probe/' + docId, doc); R.items.saved = { status: 'pass', path: 'probe/' + docId }; }
        catch (e) { R.items.saved = { status: 'fail', code: e.code, message: e.message }; }
      }
      renderItem('saved');
    });
  }

  /* 本机结论存在 localStorage，页面据此选择录音方式和"说一次就够" */
  function remember(items) {
    const prev = ls.get('probe', {}) || {};
    const out = Object.assign({}, prev, { ts: R.ts, ua: R.ua });
    for (const k of ['gum', 'recorder', 'upload', 'filePick', 'sample', 'asr', 'asrWithRec']) {
      if (items[k] && (items[k].status === 'pass' || items[k].status === 'fail')) out[k] = items[k].status;
    }
    ls.set('probe', out);
  }
  function flags() { return ls.get('probe', {}) || {}; }

  /* ---------------- 各项测试 ---------------- */
  async function getStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw { name: 'NoAPI', message: 'navigator.mediaDevices.getUserMedia 不存在' };
    return navigator.mediaDevices.getUserMedia({ audio: true });
  }
  function stopStream(s) { try { s && s.getTracks().forEach(t => t.stop()); } catch (_) {} }

  async function runGum() {
    set('gum', { status: 'running' }, false);
    try {
      stream = await getStream();
      const t = stream.getAudioTracks()[0];
      const st = t && t.getSettings ? t.getSettings() : {};
      set('gum', { status: 'pass', label: t ? t.label : '', sampleRate: st.sampleRate || null, channelCount: st.channelCount || null, echoCancellation: st.echoCancellation ?? null, noiseSuppression: st.noiseSuppression ?? null });
    } catch (e) {
      stream = null;
      set('gum', { status: 'fail', error: e.name || 'Error', message: e.message || String(e) });
    }
  }

  async function recordFor(s, sec, onTick) {
    const mime = AudioTools.pickRecorderMime();
    const rec = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 });
    const chunks = [];
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise(res => { rec.onstop = res; });
    rec.start(1000);
    for (let i = sec; i > 0; i--) { onTick && onTick(i); await sleep(1000); }
    rec.stop();
    await stopped;
    return new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
  }

  async function levelOf(blob) {
    try { const a = await AudioTools.decode(blob); return Object.assign({ duration: Math.round(a.duration * 10) / 10 }, AudioTools.level(a.samples, a.sr)); }
    catch (_) { return null; }
  }

  async function runRecorder() {
    const supported = {};
    const hasMR = typeof MediaRecorder !== 'undefined';
    for (const t of MR_TYPES) supported[t] = !!(hasMR && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    if (!hasMR) return set('recorder', { status: 'fail', supported, error: 'NoMediaRecorder' });
    if (!stream) return set('recorder', { status: 'skip', supported, message: '第 1 项没通过，无法在页面里录音' });
    try {
      recBlob = await recordFor(stream, 5, i => set('recorder', { status: 'running', message: '请说几句英文……还剩 ' + i + ' 秒' }, false));
      const lv = await levelOf(recBlob);
      set('recorder', {
        status: recBlob.size > 0 ? 'pass' : 'fail', supported, mimeType: recBlob.type, sizeBytes: recBlob.size,
        durationSec: lv ? lv.duration : null, peakDb: lv ? lv.peakDb : null, rangeDb: lv ? lv.rangeDb : null, decodable: !!lv,
      });
    } catch (e) {
      recBlob = null;
      set('recorder', { status: 'fail', supported, error: e.name || e.code || 'Error', message: e.message || String(e) });
    }
  }

  async function runUpload() {
    if (!recBlob) return set('upload', { status: 'skip', message: '没有第 2 项的录音' });
    if (!Platform.blobs.available) return set('upload', { status: 'fail', code: 'unavailable', message: 'assets 不可用' });
    const type = /mp4/i.test(recBlob.type) ? 'video/mp4' : 'video/webm';
    set('upload', { status: 'running', message: '上传中……' }, false);
    try {
      const r = await Platform.blobs.upload(recBlob, type);
      set('upload', { status: 'pass', type, id: r.id, sizeBytes: r.sizeBytes, contentType: r.contentType });
    } catch (e) {
      set('upload', { status: 'fail', type, code: e.code, message: e.message });
    }
  }

  async function onFile(file, viaCapture) {
    if (!file) return;
    set('filePick', { status: 'running', message: '读取和上传中……' }, false);
    const info = { viaCapture, name: file.name, type: file.type || '', sizeBytes: file.size };
    const lv = await levelOf(file);
    info.decodable = !!lv;
    info.durationSec = lv ? lv.duration : null;
    if (!Platform.blobs.available) return set('filePick', Object.assign(info, { status: 'fail', code: 'unavailable', message: 'assets 不可用' }));
    if (file.size > AudioTools.MAX_WRAP_BYTES) return set('filePick', Object.assign(info, { status: 'fail', code: 'too_large', message: '超过 15 MB' }));
    try {
      const b64 = await AudioTools.toBase64(file);
      const r = await Platform.blobs.upload(new Blob([b64], { type: 'text/plain' }), 'text/plain');
      info.uploadId = r.id; info.uploadType = 'text/plain'; info.uploadedBytes = r.sizeBytes;
    } catch (e) { info.code = e.code; info.message = e.message; }
    const plan = AudioTools.uploadTypeFor(file.type || AudioTools.guessMime(file.name), file.name);
    if (!plan.wrap) {
      try { const r2 = await Platform.blobs.upload(file, plan.type); info.directId = r2.id; info.directType = plan.type; }
      catch (e) { info.directType = plan.type; info.directCode = e.code; }
    }
    set('filePick', Object.assign(info, { status: info.uploadId ? 'pass' : 'fail' }));
  }

  async function runSample() {
    if (!Platform.llm.available) return set('sample', { status: 'fail', code: Platform.llm.reason || 'unavailable' });
    set('sample', { status: 'running', message: '等待 Claude……第一次会弹出同意框' }, false);
    const t0 = performance.now();
    try {
      const r = await Platform.llm.json('Reply with only {"ok": true}', { tier: 'quick' });
      set('sample', { status: r && r.ok === true ? 'pass' : 'fail', reply: JSON.stringify(r).slice(0, 200), ms: Math.round(performance.now() - t0) });
    } catch (e) {
      set('sample', { status: 'fail', code: e.code, message: e.message });
    }
  }

  async function runTts() {
    if (!window.speechSynthesis) return set('tts', { status: 'fail', message: '没有 speechSynthesis' });
    let vs = speechSynthesis.getVoices() || [];
    for (let i = 0; i < 10 && !vs.length; i++) { await sleep(300); vs = speechSynthesis.getVoices() || []; }
    const en = vs.filter(v => /^en([-_]|$)/i.test(v.lang));
    set('tts', { status: en.length ? 'pass' : 'fail', total: vs.length, english: en.slice(0, 12).map(v => v.name + ' (' + v.lang + (v.localService ? '，本地' : '') + ')') });
  }

  function recognizeOnce(maxMs) {
    return new Promise(resolve => {
      const Rec = SR();
      const rec = new Rec();
      rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
      let text = '', error = null, started = false, done = false, t = null;
      const finish = () => { if (done) return; done = true; clearTimeout(t); resolve({ text: text.trim(), error, started }); };
      rec.onstart = () => { started = true; };
      rec.onresult = e => { text = Array.from(e.results).map(x => x[0].transcript).join(' '); };
      rec.onerror = e => { error = e.error || 'error'; };
      rec.onend = finish;
      t = setTimeout(() => { try { rec.stop(); } catch (_) {} setTimeout(finish, 1500); }, maxMs);
      try { rec.start(); } catch (e) { error = e.name || 'start_failed'; finish(); }
    });
  }

  async function runAsr() {
    if (!SR()) return set('asr', { status: 'fail', exists: false, message: '这个浏览器没有语音识别 API' });
    set('asr', { status: 'running', message: '请说一句英文，比如 "Where are you from?"' }, false);
    const t0 = performance.now();
    const r = await recognizeOnce(10000);
    set('asr', { status: r.text ? 'pass' : 'fail', exists: true, text: r.text, error: r.error, started: r.started, ms: Math.round(performance.now() - t0) });
  }

  async function runAsrWithRec() {
    if (!SR()) return set('asrWithRec', { status: 'fail', message: '没有语音识别 API' });
    if (typeof MediaRecorder === 'undefined') return set('asrWithRec', { status: 'fail', message: '没有 MediaRecorder' });
    set('asrWithRec', { status: 'running', message: '请说一句英文（边识别边录音）' }, false);
    let s = null;
    try { s = await getStream(); } catch (e) { return set('asrWithRec', { status: 'fail', error: e.name, message: '拿不到麦克风：' + (e.message || e.name) }); }
    try {
      const mime = AudioTools.pickRecorderMime();
      const rec = new MediaRecorder(s, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : {});
      const chunks = [];
      rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      const stopped = new Promise(res => { rec.onstop = res; });
      rec.start(1000);
      const r = await recognizeOnce(10000);
      rec.stop(); await stopped;
      const blob = new Blob(chunks, { type: rec.mimeType || mime });
      const lv = await levelOf(blob);
      const hasAudio = !!(lv && lv.peakDb > -50 && lv.rangeDb >= 10);
      set('asrWithRec', { status: r.text && hasAudio ? 'pass' : 'fail', text: r.text, error: r.error, recSizeBytes: blob.size, peakDb: lv ? lv.peakDb : null, rangeDb: lv ? lv.rangeDb : null, hasAudio });
    } catch (e) {
      set('asrWithRec', { status: 'fail', error: e.name || 'Error', message: e.message || String(e) });
    } finally { stopStream(s); }
  }

  async function runAuto() {
    if (busy) return;
    busy = true; renderButtons();
    try {
      await runGum();
      await runRecorder();
      await runUpload();
      stopStream(stream); stream = null;
      await runSample();
      await runTts();
    } finally { busy = false; renderButtons(); }
  }

  /* ---------------- 决策表（spec §11） ---------------- */
  function verdict(it) {
    const ok = k => it[k] && it[k].status === 'pass';
    const bad = k => it[k] && (it[k].status === 'fail' || it[k].status === 'skip');
    const out = [];
    if (ok('gum') && ok('recorder') && ok('upload')) out.push(['主方案', '在页面里录音']);
    else if (bad('gum') && ok('filePick')) out.push(['备选 A', '用系统录音机录，页面负责上传。不用去对话里转发文件']);
    else if (bad('gum') && bad('filePick')) out.push(['备选 B', '录音走对话附件；页面只做文字练习和看板']);
    else if (bad('gum')) out.push(['待定', '页面里不能录音。请测第 4 项，看能不能用系统录音机']);
    if (bad('sample')) out.push(['注意', '页面内 Claude 不可用：文字练习回到 Claude 对话里做']);
    if (ok('asr') && ok('asrWithRec')) out.push(['说一次就够', '在这台设备上启用']);
    else if (ok('asr') && bad('asrWithRec')) out.push(['语音识别', '可用，但不能和录音同时用：分成两个按钮']);
    else if (bad('asr')) out.push(['语音识别', '不可用，继续用输入法的语音输入']);
    return out;
  }

  /* ---------------- 渲染 ---------------- */
  const els = {};
  function detailText(key, v) {
    if (!v) return '';
    if (v.message && v.status === 'running') return v.message;
    const parts = [];
    const add = (k, x) => { if (x !== undefined && x !== null && x !== '') parts.push(k + '：' + x); };
    switch (key) {
      case 'gum': add('错误', v.error); add('说明', v.message); add('设备', v.label); break;
      case 'recorder':
        if (v.supported) parts.push(Object.entries(v.supported).map(([t, b]) => (b ? '✓ ' : '✗ ') + t).join('  '));
        add('录到', v.mimeType); add('大小', v.sizeBytes != null ? fmtBytes(v.sizeBytes) : null); add('时长', v.durationSec != null ? v.durationSec + ' 秒' : null);
        add('音量', v.peakDb != null ? v.peakDb + ' dB，动态范围 ' + v.rangeDb + ' dB' : null); add('错误', v.error); add('说明', v.message); break;
      case 'upload': add('类型', v.type); add('资产 id', v.id); add('大小', v.sizeBytes != null ? fmtBytes(v.sizeBytes) : null); add('错误码', v.code); add('说明', v.message); break;
      case 'filePick':
        add('文件', v.name); add('类型', v.type || '（空）'); add('大小', v.sizeBytes != null ? fmtBytes(v.sizeBytes) : null);
        add('可解码', v.decodable === undefined ? null : v.decodable ? '是' : '否'); add('时长', v.durationSec != null ? v.durationSec + ' 秒' : null);
        add('base64 上传 id', v.uploadId); add('直传 ' + (v.directType || ''), v.directId || v.directCode); add('错误码', v.code); add('说明', v.message); break;
      case 'sample': add('回复', v.reply); add('耗时', v.ms != null ? v.ms + ' ms' : null); add('错误码', v.code); add('说明', v.message); break;
      case 'tts': add('语音总数', v.total); add('英文', v.english && v.english.length ? v.english.join('；') : v.status === 'fail' ? '没有' : null); add('说明', v.message); break;
      case 'asr': add('识别到', v.text || (v.status === 'fail' ? '（没有文字）' : null)); add('错误码', v.error); add('说明', v.message); break;
      case 'asrWithRec': add('识别到', v.text || (v.status === 'fail' ? '（没有文字）' : null)); add('录音有声音', v.hasAudio === undefined ? null : v.hasAudio ? '是' : '否'); add('音量', v.peakDb != null ? v.peakDb + ' dB' : null); add('错误码', v.error); add('说明', v.message); break;
      case 'saved': add('位置', v.path); add('错误码', v.code); add('说明', v.message); break;
    }
    return parts.join(' · ');
  }

  function renderItem(key) {
    const row = els['row-' + key];
    if (!row) return;
    const v = (R && R.items[key]) || { status: 'idle' };
    const [label, cls] = STATUS[v.status] || STATUS.idle;
    const chip = row.querySelector('.chip');
    chip.className = 'chip ' + cls;
    put(clear(chip), v.status === 'running' ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : '', label);
    row.querySelector('.pi-d').textContent = detailText(key, v);
  }

  function renderVerdict() {
    const box = els.verdict;
    if (!box) return;
    const lines = verdict((R && R.items) || {});
    clear(box);
    if (!lines.length) { box.hidden = true; return; }
    box.hidden = false;
    put(box, h('p', { class: 'label' }, '结论（按 spec 决策表）'), ...lines.map(([k, v]) => h('p', null, h('b', null, k + '：'), v)));
  }

  function renderButtons() {
    if (els.auto) { els.auto.disabled = busy; els.auto.textContent = busy ? '检测中……' : '运行自动项（1 2 3 5 6）'; }
  }

  function mount(el) {
    root = el;
    fresh();
    const fileCap = h('input', { type: 'file', accept: 'audio/*', capture: '', id: 'probe-file-cap', hidden: true, onchange: e => onFile(e.target.files[0], true) });
    const filePick = h('input', { type: 'file', accept: 'audio/*,video/webm,video/mp4,.m4a,.amr,.aac,.3gp,.mp3,.wav,.ogg', id: 'probe-file-pick', hidden: true, onchange: e => onFile(e.target.files[0], false) });
    const actions = {
      filePick: [h('button', { class: 'btn small ghost', type: 'button', onclick: () => fileCap.click() }, '用系统录音机录'), h('button', { class: 'btn small ghost', type: 'button', onclick: () => filePick.click() }, '选择录音文件')],
      tts: [h('button', { class: 'btn small ghost', type: 'button', onclick: () => TTS.speak("Buen Camino! How's it going?") }, '试听')],
      asr: [h('button', { class: 'btn small ghost', type: 'button', onclick: () => runAsr() }, '开始（说一句英文）')],
      asrWithRec: [h('button', { class: 'btn small ghost', type: 'button', onclick: () => runAsrWithRec() }, '开始（说一句英文）')],
    };
    const list = h('div', { class: 'probe-list' }, ITEMS.map(it => {
      const row = h('div', { class: 'probe-item' },
        h('span', { class: 'pi-n' }, String(it.n)),
        h('div', null, h('div', { class: 'pi-t' }, it.title), h('div', { class: 'small muted' }, it.sub)),
        h('span', { class: 'chip' }, '未测'),
        h('div', { class: 'pi-d' }),
        actions[it.key] ? h('div', { class: 'pi-a' }, actions[it.key]) : null);
      els['row-' + it.key] = row;
      return row;
    }));
    els.auto = h('button', { class: 'btn', type: 'button', onclick: runAuto }, '运行自动项（1 2 3 5 6）');
    els.verdict = h('div', { class: 'notice info stack-s', hidden: true });
    const ctx = R.context;
    const ctxLine = h('p', { class: 'small muted' },
      R.device + ' · 数据库 ' + (ctx.db ? '✓' : '✗') + ' · 资产 ' + (ctx.assets ? '✓' : '✗') + ' · Claude ' + (ctx.sample ? '✓' : '✗') + ' · 下载 ' + (ctx.downloads ? '✓' : '✗') +
      ' · 麦克风策略 ' + (ctx.micPolicy === null ? '未知' : ctx.micPolicy ? '允许' : '禁止'));
    put(clear(root), 
      h('div', { class: 'stack' },
        h('p', { class: 'small' }, '先点"运行自动项"，第 2 项会录 5 秒，请对着手机说几句英文。第 4、7、8 项需要你手动点。结果自动保存，不用转述给 Claude。'),
        ctxLine,
        h('div', { class: 'row' }, els.auto, h('button', { class: 'btn ghost', type: 'button', onclick: () => { fresh(); ITEMS.forEach(i => renderItem(i.key)); renderVerdict(); toast('已开始新的一轮检测'); } }, '重新开始')),
        list, fileCap, filePick, els.verdict));
    ITEMS.forEach(i => renderItem(i.key));
  }

  return { mount, flags, verdict };
})();
