/* =====================================================================
 * 录音：页面里录（MediaRecorder）或用系统录音机 / 选文件（备选 A），
 * 本地粗测停顿，上传到 assets，写 recordings（status=pending）。
 * 分析由 Claude 会话按 tools/RUNBOOK.md 完成后写回。
 * ===================================================================== */

const Record = (() => {
  let root = null, built = false, visible = false;
  const els = {};
  let live = null;        // 正在录音
  let pending = null;     // 最近一段（本地结果 + 上传状态）
  const expanded = new Set();
  const bodyCache = new Map();
  const blobUrls = {};

  const UPLOAD_ERR_ZH = {
    too_large: '文件太大了（上限：原始文件 15 MB，或 20 MB 的 webm/mp4）。录短一点再传。',
    quota_or_state: '存储空间满了。到下面的列表里删掉分析完的音频再试。',
    rate_limited: '传得太频繁了，稍等一下再点重新上传。',
    unsupported_type: '这个格式传不上去。',
    not_granted: '只有这个 artifact 的所有者和编辑者能上传录音。',
    capability_disabled: '当前环境里不能上传。',
    unavailable: '当前环境里不能上传（需要在 Claude 的 artifact 查看器里打开）。',
    upstream_auth: '登录状态失效了，刷新页面或重新登录后再试。',
    store_unavailable: '存储服务暂时不可用，稍后点重新上传。',
  };
  const uploadErrZh = e => UPLOAD_ERR_ZH[e && e.code] || ('上传失败（' + ((e && e.code) || '未知错误') + '）。录音还在，可以重新上传。');

  function init(el) {
    root = el;
    Bus.on('recordings', () => { if (visible) { renderList(); renderBanner(); } });
    ['config', 'audio', 'turns', 'bank'].forEach(k => Bus.on(k, () => { if (visible) renderBanner(); }));
    Bus.on('nodeOpened', () => { if (built) renderPrompt(); });
  }
  function show() {
    visible = true;
    if (!built) build();
    renderPrompt(); renderStage(); renderBanner(); renderList();
  }
  function hide() { visible = false; }

  /* ---------------- 题目 ---------------- */
  function promptMode() { return ls.get('recPrompt', 'node'); }
  function currentPrompt() {
    const m = promptMode();
    if (m === 'intro') return { prompt: FIXED_PROMPTS.intro.en, fixedPrompt: 'intro', nodeId: null, label: FIXED_PROMPTS.intro.zh };
    if (m === 'custom') { const t = str(els.custom && els.custom.value); return { prompt: t || '（自定义题目）', fixedPrompt: null, nodeId: null, label: '自定义' }; }
    const n = S.nodeMap[Practice.currentNodeId];
    if (n && n.main_q) return { prompt: n.main_q, fixedPrompt: null, nodeId: n.id, label: n.id + ' ' + n.title_zh };
    return { prompt: FIXED_PROMPTS.intro.en, fixedPrompt: 'intro', nodeId: null, label: FIXED_PROMPTS.intro.zh };
  }

  function build() {
    built = true;
    els.banner = h('div');
    els.seg = h('div', { class: 'seg', role: 'group', 'aria-label': '题目' });
    els.promptText = h('p', { class: 'en' });
    els.promptLabel = h('p', { class: 'small muted' });
    els.custom = h('input', { type: 'text', id: 'rec-custom', class: 'en-s', placeholder: '写下题目，比如 Tell me about your hometown.', hidden: true, oninput: () => ls.set('recCustom', els.custom.value) });
    els.custom.value = ls.get('recCustom', '') || '';
    els.stage = h('div', { class: 'rec-stage' });
    els.result = h('div', { class: 'stack' });
    els.fileCap = h('input', { type: 'file', accept: 'audio/*', capture: '', id: 'rec-file-cap', hidden: true, onchange: onFile });
    els.filePick = h('input', { type: 'file', accept: 'audio/*,video/webm,video/mp4,.m4a,.amr,.aac,.3gp,.mp3,.wav,.ogg,.webm', id: 'rec-file-pick', hidden: true, onchange: onFile });
    els.list = h('ul', { class: 'rec-list' });
    put(clear(root), 
      els.banner,
      h('section', { class: 'card stack' },
        h('h2', { class: 'section-title' }, '录一段'),
        els.seg, h('div', { class: 'stack-s' }, els.promptLabel, els.promptText, els.custom),
        els.stage, els.result, els.fileCap, els.filePick),
      h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, '录音列表'), h('span', { class: 'small muted', id: 'rec-count' })),
      els.list,
      h('p', { class: 'small muted' }, '页面里录音和选文件都不行时：直接把录音文件作为附件发到 Claude 对话里，说"分析"。结果会出现在这个列表里。'));
  }

  function renderPrompt() {
    if (!built) return;
    const m = promptMode();
    put(clear(els.seg), ...[['node', '当前节点'], ['intro', '自我介绍'], ['custom', '自定义']].map(([k, t]) =>
      h('button', { type: 'button', 'aria-pressed': String(m === k), onclick: () => { ls.set('recPrompt', k); renderPrompt(); } }, t)));
    const p = currentPrompt();
    els.custom.hidden = m !== 'custom';
    els.promptText.hidden = m === 'custom';
    els.promptText.textContent = p.prompt;
    els.promptLabel.textContent = m === 'intro' ? '固定题，用来看流利度趋势' : m === 'custom' ? '自定义题目' : p.label;
  }

  /* ---------------- 录音方式 ---------------- */
  function route() {
    if (!Platform.blobs.available) return 'none';
    const forced = ls.get('recRoute');
    if (forced === 'file' || forced === 'page') return forced;
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || typeof MediaRecorder === 'undefined') return 'file';
    if (Probe.flags().gum === 'fail' || ls.get('micBlocked', false)) return 'file';
    return 'page';
  }

  function renderStage(errName) {
    if (!built) return;
    const st = clear(els.stage);
    const r = route();
    if (r === 'none') {
      put(st, h('div', { class: 'notice' }, Platform.store.available ? '这个视图不能上传录音：只有 artifact 的所有者和编辑者能上传。' : '需要在 Claude 的 artifact 查看器里打开才能上传录音。'));
      return;
    }
    if (r === 'page') {
      const max = S.config.maxRecSec || 180;
      els.recBtn = h('button', { class: 'rec-btn' + (live ? ' live' : ''), type: 'button', onclick: () => (live ? stopRec() : startRec()) }, live ? '停止' : '开始录音');
      els.timer = h('div', { class: 'timer', 'aria-live': 'off' }, '0:00 / ' + fmtDur(max));
      els.meterFill = h('span');
      put(st, els.recBtn, els.timer, h('div', { class: 'meter', 'aria-hidden': 'true' }, els.meterFill),
        live ? null : h('button', { class: 'link-btn', type: 'button', onclick: () => { ls.set('recRoute', 'file'); renderStage(); } }, '改用系统录音机'));
      return;
    }
    const canPage = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && typeof MediaRecorder !== 'undefined';
    put(st, 
      h('p', { class: 'small', style: 'text-align:center' }, errName ? '页面里用不了麦克风（' + errName + '）。' : ls.get('micBlocked', false) || Probe.flags().gum === 'fail' ? '这台设备上页面里用不了麦克风。' : '',
        '用手机自带的录音机录好，再传上来：'),
      h('div', { class: 'file-btns' },
        h('button', { class: 'btn', type: 'button', onclick: () => els.fileCap.click() }, '用系统录音机录'),
        h('button', { class: 'btn ghost', type: 'button', onclick: () => els.filePick.click() }, '选择录音文件')),
      h('p', { class: 'small muted', style: 'text-align:center' }, '"用系统录音机录"拿回来的通常是 AMR（电话音质），能分析，但词尾听得不准，页面也做不了粗测。想要更准：先在手机录音机 App 里录，再点"选择录音文件"。固定题最好一直用同一种方式录，趋势才可比。'),
      canPage ? h('button', { class: 'link-btn', type: 'button', onclick: () => { ls.del('micBlocked'); ls.set('recRoute', 'page'); renderStage(); } }, '再试页面里录音') : null);
  }

  async function startRec() {
    if (live) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      ls.set('micBlocked', true); ls.del('recRoute');
      renderStage(e.name || 'Error');
      return;
    }
    const mime = AudioTools.pickRecorderMime();
    let mr;
    try { mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 }); }
    catch (e) { stream.getTracks().forEach(t => t.stop()); toast('无法开始录音：' + (e.name || e)); return; }
    const chunks = [];
    mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    live = { stream, mr, chunks, t0: performance.now(), snap: currentPrompt(), ctx: null, raf: 0, timer: 0, wake: null };
    mr.onstop = finishRec;
    mr.start(1000);
    renderStage();
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      live.ctx = new AC();
      const an = live.ctx.createAnalyser();
      an.fftSize = 1024;
      live.ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const loop = () => {
        if (!live) return;
        an.getFloatTimeDomainData(buf);
        let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
        const db = 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
        if (els.meterFill) els.meterFill.style.width = Math.max(0, Math.min(100, ((db + 60) / 55) * 100)) + '%';
        live.raf = requestAnimationFrame(loop);
      };
      loop();
    } catch (_) {}
    live.timer = setInterval(() => {
      if (!live) return;
      const sec = (performance.now() - live.t0) / 1000, max = S.config.maxRecSec || 180;
      if (els.timer) els.timer.textContent = fmtDur(sec) + ' / ' + fmtDur(max);
      if (sec >= max) stopRec();
    }, 250);
    try { if (navigator.wakeLock) live.wake = await navigator.wakeLock.request('screen'); } catch (_) {}
  }
  function stopRec() { if (live && live.mr.state !== 'inactive') live.mr.stop(); }
  function finishRec() {
    const r = live;
    live = null;
    if (!r) return;
    clearInterval(r.timer); cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach(t => t.stop());
    if (r.ctx) r.ctx.close().catch(() => {});
    if (r.wake && r.wake.release) r.wake.release().catch(() => {});
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
    const durationSec = Math.round((performance.now() - r.t0) / 100) / 10;
    renderStage();
    if (!blob.size) { toast('没有录到声音'); return; }
    handleBlob(blob, { recMime: blob.type, durationSec, fileName: null, snap: r.snap });
  }

  function onFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    handleBlob(f, { recMime: f.type || AudioTools.guessMime(f.name), fileName: f.name, durationSec: null, snap: currentPrompt() });
  }

  function mediaDuration(url) {
    return new Promise(res => {
      const a = new Audio();
      const done = v => { res(v); a.src = ''; };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(isFinite(a.duration) ? Math.round(a.duration * 10) / 10 : null);
      a.onerror = () => done(null);
      setTimeout(() => done(null), 4000);
      a.src = url;
    });
  }

  async function handleBlob(blob, meta) {
    const item = {
      id: uid('r'), blob, recMime: meta.recMime || '', fileName: meta.fileName, durationSec: meta.durationSec,
      snap: meta.snap, local: null, localFailed: false, state: 'local', error: null, uploaded: null,
      url: URL.createObjectURL(blob),
    };
    pending = item;
    renderResult();
    try {
      const a = await AudioTools.decode(blob);
      item.local = AudioTools.roughPauses(a.samples, a.sr, S.config.pauseSec || 0.5);
      if (!item.durationSec) item.durationSec = Math.round(a.duration * 10) / 10;
    } catch (_) {
      item.localFailed = true;
      if (!item.durationSec) item.durationSec = await mediaDuration(item.url);
    }
    renderResult();
    await upload(item);
  }

  async function upload(item) {
    item.state = 'uploading'; item.error = null;
    renderResult();
    try {
      await saveRecording({
        id: item.id, blob: item.blob, recMime: item.recMime, fileName: item.fileName, durationSec: item.durationSec, local: item.local,
        prompt: item.snap.prompt, fixedPrompt: item.snap.fixedPrompt, nodeId: item.snap.nodeId, turnId: null, uploaded: item.uploaded,
      }, s => { item.state = s; if (pending === item) renderResult(); });
      item.state = 'done';
    } catch (e) {
      item.state = 'failed'; item.error = e;
      if (e && e.uploaded) item.uploaded = e.uploaded;
    }
    if (pending === item) renderResult();
  }

  /* 上传并写 recordings（练习页"说一次就够"也用它） */
  async function saveRecording(o, onState) {
    const step = onState || (() => {});
    let up = o.uploaded;
    if (!up) { step('uploading'); up = await AudioTools.uploadRecording(o.blob, o.recMime, o.fileName); }
    step('saving');
    const id = o.id || uid('r');
    const doc = {
      nodeId: o.nodeId || null, prompt: o.prompt || '', fixedPrompt: o.fixedPrompt || null, turnId: o.turnId || null,
      assetId: up.res.id, uploadType: up.uploadType, recMime: o.recMime || '', durationSec: o.durationSec == null ? null : o.durationSec,
      sizeBytes: o.blob.size, fileName: o.fileName || null, local: o.local || null,
      status: 'pending', analysis: null, createdAt: nowIso(), analyzedAt: null,
    };
    try { await Platform.store.set('recordings/' + id, doc); }
    catch (e) { throw Object.assign({}, e, { uploaded: up }); }
    return { id, assetId: up.res.id };
  }

  function localStats(local, durationSec) {
    if (!local) return null;
    return h('div', { class: 'stack-s' },
      h('div', { class: 'stats' },
        stat(local.pauses, '停顿次数'),
        stat(local.longestPauseSec + ' 秒', '最长停顿'),
        stat(Math.round(local.speakingRatio * 100) + '%', '说话时间占比'),
        durationSec != null ? stat(fmtDur(durationSec), '时长') : null),
      h('p', { class: 'small muted' }, '粗测，以分析结果为准。', local.noisy ? '底噪比较大，粗测可能不准。' : ''));
  }
  function stat(v, k) { return h('div', { class: 'stat' }, h('span', { class: 'v mono' }, String(v)), h('span', { class: 'k' }, k)); }

  function renderResult() {
    if (!built) return;
    const box = clear(els.result), it = pending;
    if (!it) return;
    const status = {
      local: [h('span', { class: 'spin' }), ' 本地粗测中……'],
      uploading: [h('span', { class: 'spin' }), ' 上传中……'],
      saving: [h('span', { class: 'spin' }), ' 写入记录……'],
      done: [h('span', { class: 'chip ok' }, '已上传'), ' 等分析。录好几段后把上面那句话发给 Claude。'],
      failed: [h('span', { class: 'chip high' }, '没传上'), ' ', uploadErrZh(it.error)],
    }[it.state];
    put(box, 
      h('p', { class: 'label' }, '刚录的一段'),
      h('audio', { controls: true, src: it.url, preload: 'metadata' }),
      localStats(it.local, it.durationSec),
      it.localFailed ? h('p', { class: 'small muted' }, '这个格式在页面里解码不了，跳过粗测，直接上传。') : null,
      it.durationSec > (S.config.maxRecSec || 180) ? h('p', { class: 'small muted' }, '超过 3 分钟了，下次录短一点。') : null,
      h('p', { class: 'status row' }, ...status),
      it.state === 'failed' ? h('div', null, h('button', { class: 'btn ghost small', type: 'button', onclick: () => upload(it) }, '重新上传')) : null);
  }

  /* ---------------- 提示横幅 ---------------- */
  /* 需要 Claude 会话做的事：分析录音、生成真人感发音。发一句话就都做。 */
  function taskBanner() {
    const pend = S.recordings.filter(r => r.status === 'pending').length;
    const analyzing = S.recordings.filter(r => r.status === 'analyzing').length;
    const missing = Data.audioMissing();
    const url = S.config.artifactUrl;
    const text = '请处理口语特训的新内容（分析录音、生成发音）：' + (url || '（这个页面的地址）');
    const code = h('code', null, text);
    const todo = [pend ? pend + ' 段录音待分析' : null, analyzing ? analyzing + ' 段正在分析' : null, missing ? missing + ' 句还没有真人发音' : null].filter(Boolean);
    return h('div', { class: 'notice info banner' },
      h('p', null, todo.length ? h('b', null, '有 ' + todo.join('，') + '。') : null, ' 把下面这句话发给 Claude，分析结果和发音会自动出现在页面里：'),
      h('div', { class: 'copy-line' }, code, h('button', { class: 'btn small', type: 'button', onclick: () => copyText(text, code) }, '复制')));
  }
  function renderBanner() {
    if (!built) return;
    put(clear(els.banner), taskBanner());
  }

  /* ---------------- 列表 ---------------- */
  const REC_STATUS = { pending: ['待分析', 'warn'], analyzing: ['分析中', 'accent'], analyzed: ['已分析', 'ok'], failed: ['失败', 'high'] };

  function renderList() {
    if (!built) return;
    const recs = S.recordings;
    const cnt = $('#rec-count');
    if (cnt) cnt.textContent = recs.length ? recs.length + ' 段' : '';
    clear(els.list);
    if (!recs.length) { put(els.list, h('li', { class: 'muted' }, S.loaded.recordings ? '还没有录音。' : '读取中……')); return; }
    for (const r of recs) {
      const [label, cls] = REC_STATUS[r.status] || [r.status, ''];
      const open = expanded.has(r.id);
      const head = h('button', { class: 'rec-head', type: 'button', 'aria-expanded': String(open), onclick: () => { if (expanded.has(r.id)) expanded.delete(r.id); else expanded.add(r.id); renderList(); } },
        h('span', { class: 'rp' }, r.prompt || '（没有题目）'),
        h('span', { class: 'rm' }, [fmtWhen(r.createdAt), r.durationSec != null ? fmtDur(r.durationSec) : null, r.fixedPrompt === 'intro' ? '固定题' : null, r.nodeId, r.turnId ? '随文字作答录下' : null].filter(Boolean).join(' · ')),
        h('span', { class: 'chip ' + cls }, label));
      put(els.list, h('li', { class: 'rec-item' }, head, open ? cachedBody(r) : null));
    }
  }

  function cachedBody(r) {
    const key = [r.status, r.analyzedAt, r.assetId, r.error].join('|');
    const c = bodyCache.get(r.id);
    if (c && c.key === key) return c.el;
    const el = recBody(r);
    bodyCache.set(r.id, { key, el });
    return el;
  }

  function player(r) {
    if (!r.assetId) return h('p', { class: 'small muted' }, r.audioDeletedAt ? '音频已删除，分析结果保留。' : '没有音频文件（来自对话附件）。');
    const box = h('div');
    if (r.uploadType === 'text/plain') {
      const load = async () => {
        put(clear(box), h('p', { class: 'small muted' }, '加载中……'));
        try {
          if (!blobUrls[r.id]) blobUrls[r.id] = URL.createObjectURL(AudioTools.base64ToBlob(await Platform.blobs.fetchText(r.assetId), r.recMime));
          put(clear(box), h('audio', { controls: true, src: blobUrls[r.id] }));
        } catch (e) { put(clear(box), h('p', { class: 'small muted' }, '加载失败（' + (e.code || e.message || e) + '）')); }
      };
      put(box, h('button', { class: 'btn ghost small', type: 'button', onclick: load }, '加载音频'));
      return box;
    }
    const src = Platform.blobs.url(r.assetId);
    const audio = h('audio', { controls: true, preload: 'none', src });
    audio.addEventListener('error', () => { put(clear(box), h('video', { controls: true, preload: 'metadata', playsinline: true, src })); }, { once: true });
    put(box, audio);
    return box;
  }

  const LC_KIND = { grammar: '语法错误处', pronunciation: '发音问题', unclear: '没说清' };

  function analysisView(r) {
    const a = r.analysis || {};
    const lowConf = S.config.lowConf || 0.6;
    const kinds = {}, notes = {}, pausesAfter = {};
    arr(a.pause_kinds).forEach(k => { kinds[k.after_index] = k.kind; });
    arr(a.lowconf_notes).forEach(n => { notes[n.index] = n; });
    arr(a.pauses).forEach(p => { pausesAfter[p.after_index] = p; });
    const lowIdx = new Set(arr(a.low_confidence).map(x => x.index));
    const note = h('div', { class: 'lc-note', hidden: true, role: 'status' });
    const tr = h('p', { class: 'transcript' });
    const words = arr(a.words);
    if (words.length) {
      words.forEach((w, i) => {
        const low = lowIdx.has(i) || (typeof w.c === 'number' && w.c < lowConf);
        const showNote = () => {
          const n = notes[i];
          put(clear(note), h('b', { class: 'en-s' }, w.w), ' 置信度 ' + (typeof w.c === 'number' ? w.c.toFixed(2) : '?') + '。',
            n ? [' ' + (LC_KIND[n.kind] || n.kind || '') + (n.target ? '，原本想说 ' : ''), n.target ? h('span', { class: 'en-s' }, n.target) : null, n.note_zh ? '。' + n.note_zh : ''] : ' 机器没听清这个词。');
          note.hidden = false;
        };
        put(tr, low ? h('span', { class: 'w low', tabindex: '0', role: 'button', onclick: showNote, onkeydown: e => { if (e.key === 'Enter') showNote(); } }, w.w) : h('span', { class: 'w' }, w.w), ' ');
        const p = pausesAfter[i];
        if (p) {
          const kind = kinds[i] || (p.after_punct ? 'boundary' : 'mid');
          put(tr, h('span', { class: 'pz ' + kind, title: kind === 'mid' ? '句中卡壳' : '句间停顿' }, '‖' + Number(p.sec).toFixed(1) + 's‖'), ' ');
        }
      });
    } else tr.textContent = a.text || '（没有转写）';
    const n = v => (v == null ? '–' : v);
    return h('div', { class: 'stack' },
      h('p', { class: 'label' }, '转写'),
      tr,
      h('div', { class: 'legend' }, h('span', null, h('span', { class: 'pz mid' }, '‖1.2s‖'), ' 句中卡壳'), h('span', null, h('span', { class: 'pz' }, '‖0.8s‖'), ' 句间停顿'), h('span', null, h('span', { class: 'transcript' }, h('span', { class: 'w low' }, 'word')), ' 机器没听清，点开看说明')),
      note,
      h('div', { class: 'stats' },
        stat(n(a.wpm), '语速（词/分）'),
        stat(n(a.wpm_excl_pauses), '去掉停顿后的语速'),
        stat(n(a.pauses_per_min), '每分钟停顿'),
        stat(n(a.mean_length_of_run), '平均连续词数'),
        stat(a.longest_pause_s == null ? '–' : a.longest_pause_s + ' 秒', '最长停顿')),
      a.pause_method === 'word_gaps' ? h('p', { class: 'small muted' }, '底噪太大，停顿按词与词的间隔估算，会偏短。') : null,
      h('div', { class: 'fb' }, errorsBlock(a.errors)),
      a.summary_zh ? h('div', { class: 'notice info', style: 'white-space:pre-wrap' }, a.summary_zh) : null);
  }

  function recBody(r) {
    const body = h('div', { class: 'rec-body' });
    put(body, player(r));
    if (r.status === 'analyzed' && r.analysis) put(body, analysisView(r));
    else if (r.status === 'failed') put(body, h('div', { class: 'notice bad' }, '分析失败' + (r.error ? '：' + r.error : '') + '。在对话里说"重试失败的录音"。'));
    else if (r.status === 'analyzing') put(body, h('p', { class: 'small muted' }, 'Claude 正在分析……'));
    else put(body, h('p', { class: 'small muted' }, '还没分析。把上面那句话发给 Claude。'));
    if (r.local && r.status !== 'analyzed') put(body, localStats(r.local, r.durationSec));
    put(body, deleteControls(r));
    return body;
  }

  function deleteControls(r) {
    const box = h('div', { class: 'row' });
    const analyzed = r.status === 'analyzed';
    if (analyzed && !r.assetId) return box;
    const label = analyzed ? '删除音频（保留分析结果）' : '删除这条录音';
    const ask = () => {
      put(clear(box), h('span', { class: 'small' }, analyzed ? '删掉音频后不能再回放。' : '录音和记录都会删掉。'),
        h('button', { class: 'btn danger small', type: 'button', onclick: doDelete }, '确认删除'),
        h('button', { class: 'btn quiet small', type: 'button', onclick: () => put(clear(box), first()) }, '取消'));
    };
    const first = () => h('button', { class: 'btn quiet small', type: 'button', onclick: ask }, label);
    const doDelete = async () => {
      if (!Platform.blobs.available) { toast('这个视图不能删除文件'); return; }
      put(clear(box), h('span', { class: 'spin' }));
      try {
        if (r.assetId) await Platform.blobs.remove(r.assetId);
        if (analyzed) await Platform.store.update('recordings/' + r.id, { assetId: null, audioDeletedAt: nowIso() });
        else { await Platform.store.remove('recordings/' + r.id); expanded.delete(r.id); }
        toast('已删除');
      } catch (e) { toast('删除失败：' + (e.code || e)); put(clear(box), first()); }
    };
    put(box, first());
    return box;
  }

  return { init, show, hide, saveRecording, taskBanner };
})();
