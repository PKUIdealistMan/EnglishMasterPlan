/* =====================================================================
 * 练习：节点列表、节点页（听懂 / 逐句反馈 / 实战对话）、盖章生成口袋本
 * ===================================================================== */

/* ---------- 反馈结构校验：不信任未验证的 JSON ---------- */
function cleanErrors(list) {
  return arr(list).map(e => {
    if (!e || typeof e !== 'object') return null;
    let type = str(e.type).toUpperCase().replace('_', '-');
    if (!ERROR_MAP[type]) type = 'STRUCT';
    const orig = str(e.orig), fix = str(e.fix);
    if (!orig && !fix) return null;
    const sev = e.sev === 'high' || e.sev === 'low' ? e.sev : (ERROR_MAP[type].sev || 'low');
    return { type, orig, fix, sev, asr_suspect: e.asr_suspect === true && ASR_SUSPECT_TYPES.includes(type), note_zh: str(e.note_zh) };
  }).filter(Boolean);
}
const normText = s => str(s).toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim();
function cleanFeedback(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw { code: 'bad_shape', text: JSON.stringify(x) };
  const corrected = str(x.corrected);
  if (!corrected) throw { code: 'bad_shape', text: JSON.stringify(x) };
  let natural = x.natural == null ? null : (str(x.natural) || null);
  if (natural && normText(natural) === normText(corrected)) natural = null;
  return {
    corrected, natural,
    errors: cleanErrors(x.errors),
    asked_back: x.asked_back === true,
    vocab: arr(x.vocab).map(v => (v && typeof v === 'object' ? { zh: str(v.zh), en: str(v.en), example: str(v.example) } : null)).filter(v => v && v.zh && v.en).slice(0, 8),
    followup: str(x.followup),
  };
}
const sortErrors = errs => arr(errs).slice().sort((a, b) => (a.sev === 'high' ? 0 : 1) - (b.sev === 'high' ? 0 : 1));

/* ---------- 反馈卡片的零件（录音分析页也用） ---------- */
function errChip(e) {
  const t = ERROR_MAP[e.type];
  const note = h('span', { class: 'note', hidden: true }, e.note_zh || '（没有说明）');
  return h('button', {
    class: 'err sev-' + (e.sev === 'high' ? 'high' : 'low'), type: 'button', 'aria-expanded': 'false',
    onclick: ev => { note.hidden = !note.hidden; ev.currentTarget.setAttribute('aria-expanded', String(!note.hidden)); },
  },
    h('span', { class: 'err-top' },
      h('span', { class: 'code' }, e.type),
      h('span', { class: 'name' }, t ? t.name : ''),
      e.sev === 'high' ? h('span', { class: 'chip high' }, '高') : null,
      e.asr_suspect ? h('span', { class: 'asr' }, '可能是识别问题') : null),
    h('span', { class: 'fix' }, e.orig ? h('s', null, e.orig) : null, e.orig ? ' → ' : '', e.fix),
    note);
}
function errorsBlock(errors) {
  const list = sortErrors(errors);
  const lbl = h('span', { class: 'lbl' }, '错误');
  if (!list.length) return h('div', { class: 'fb-row' }, lbl, h('div', null, h('span', { class: 'chip ok' }, '没有发现错误')), h('span'));
  const shown = list.slice(0, MAX_SHOWN_ERRORS), rest = list.slice(MAX_SHOWN_ERRORS);
  const box = h('div', { class: 'errs' }, shown.map(errChip));
  if (rest.length) {
    const more = h('div', { class: 'errs', hidden: true }, rest.map(errChip));
    const label = '还有 ' + rest.length + ' 个';
    put(box, more, h('button', { class: 'link-btn', type: 'button', onclick: ev => { more.hidden = !more.hidden; ev.currentTarget.textContent = more.hidden ? label : '收起'; } }, label));
  }
  return h('div', { class: 'fb-row' }, lbl, box, h('span'));
}
function fbRow(label, text, cls) {
  return h('div', { class: 'fb-row ' + (cls || '') }, h('span', { class: 'lbl' }, label), h('p', { class: 'en' }, text), sayBtn(text));
}
function bubbleThem(text, who) {
  return h('div', { class: 'bubble them' }, who ? h('span', { class: 'who' }, who) : null, h('div', { class: 'q-line' }, h('p', { class: 'en' }, text), sayBtn(text)));
}
function bubbleMe(text) { return h('div', { class: 'bubble me' }, h('p', { class: 'en' }, text)); }

function turnCard(t) {
  const node = S.nodeMap[t.nodeId];
  const who = node && node.track === 'service' ? '工作人员' : '旅伴';
  const askBack = node && node.track === 'social' && t.mode === 'drill' && !t.asked_back
    ? h('p', { class: 'askback' }, '没有反问。结尾加一句，比如 ', h('span', { class: 'en-s' }, 'What about you?'))
    : null;
  const vocab = arr(t.vocab).length ? h('p', { class: 'fb-extra' }, '词汇缺口：', t.vocab.map(v => v.zh + ' → ' + v.en).join('；')) : null;
  return h('article', { class: 'turn' },
    t.q ? bubbleThem(t.q, who) : null,
    bubbleMe(t.raw),
    h('div', { class: 'card fb' },
      fbRow('改后', t.corrected, 'corrected'),
      errorsBlock(t.errors),
      t.natural ? fbRow('更自然', t.natural) : null,
      askBack, vocab));
}

function llmNotice() {
  return h('div', { class: 'notice' }, h('b', null, '页面内 Claude 用不了。'), sampleErrZh(Platform.llm.reason || 'unavailable'),
    ' 文字练习请回到 Claude 对话里做；这里还可以看听懂材料、录音和看板。');
}
function stampEl(status) { const s = status || 'todo'; return h('span', { class: 'stamp ' + s }, STATUS_ZH[s] || s); }

/* ---------- "说一次就够"：页面内语音识别，可选同时录音（M0 第 7、8 项通过才启用） ---------- */
const Voice = (() => {
  const SRc = () => window.SpeechRecognition || window.webkitSpeechRecognition || null;
  function mode() { return ls.get('voiceMode', 'auto'); }
  function enabled() {
    if (!SRc() || mode() === 'off' || ls.get('voiceBlocked', false)) return false;
    return mode() === 'on' || Probe.flags().asr === 'pass';
  }
  function withRecording() { return Probe.flags().asrWithRec === 'pass' && typeof MediaRecorder !== 'undefined'; }

  async function start(ta, onEnd) {
    const rec = new (SRc())();
    rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = true; rec.maxAlternatives = 1;
    const base = ta.value.trim() ? ta.value.trim() + ' ' : '';
    const st = { error: null, blob: null, mime: '', durationSec: null };
    let stream = null, mr = null, chunks = [], t0 = 0, recStopped = null;
    if (withRecording()) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = AudioTools.pickRecorderMime();
        mr = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 });
        mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        recStopped = new Promise(res => { mr.onstop = res; });
        mr.start(1000); t0 = performance.now();
      } catch (_) { mr = null; if (stream) stream.getTracks().forEach(t => t.stop()); stream = null; }
    }
    rec.onresult = e => {
      let fin = '', interim = '';
      for (const r of Array.from(e.results)) { if (r.isFinal) fin += r[0].transcript; else interim += r[0].transcript; }
      ta.value = (base + fin + interim).replace(/\s+/g, ' ').trimStart();
    };
    rec.onerror = e => {
      st.error = e.error || 'error';
      if (st.error === 'not-allowed' || st.error === 'service-not-allowed') ls.set('voiceBlocked', true);
    };
    rec.onend = async () => {
      if (mr && mr.state !== 'inactive') { mr.stop(); await recStopped; }
      if (stream) stream.getTracks().forEach(t => t.stop());
      if (mr && chunks.length) {
        st.blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        st.mime = st.blob.type; st.durationSec = Math.round((performance.now() - t0) / 100) / 10;
      }
      ta.dispatchEvent(new Event('input'));
      onEnd(st);
    };
    try { rec.start(); } catch (e) { st.error = e.name || 'start_failed'; rec.onend(); }
    return { stop() { try { rec.stop(); } catch (_) {} } };
  }
  return { enabled, withRecording, start, mode };
})();

/* ===================================================================== */
const Practice = (() => {
  let root = null, cur = null, autoOpened = false;

  function init(el) {
    root = el;
    Bus.on('nodes', () => {
      if (!autoOpened && S.nodes.length) { autoOpened = true; autoOpen(); return; }
      if (cur) { const n = S.nodeMap[cur.id]; if (n) { cur.node = n; refreshHead(); } }
      else renderList();
    });
    Bus.on('turns', () => { if (cur) refreshHead(); else renderList(); });
    Platform.llm.onBlocked(() => { if (cur) openNode(cur.id, true); });
    Bus.on('personas', () => { if (cur && !cur.convo && !cur.busy) renderConvo(); });
  }

  function autoOpen() {
    const last = ls.get('lastNode');
    if (last && S.nodeMap[last]) return openNode(last);
    const first = S.nodes.find(n => n.priority === 1 && n.status !== 'done' && n.track !== 'listening');
    if (first) openNode(first.id); else renderList();
  }

  function show() {
    if (!Platform.store.available) return renderNoDb();
    if (!S.loaded.nodes) { put(clear(root), h('p', { class: 'muted' }, '正在读取大纲……')); return; }
    if (cur) return;
    renderList();
  }
  function renderNoDb() {
    put(clear(root), h('div', { class: 'notice bad' }, h('b', null, '没有连上数据库。'), '请在 claude.ai 的 artifact 查看器里打开这个页面。'));
  }

  /* ---------------- 节点列表 ---------------- */
  function renderList() {
    if (!root || cur || !S.loaded.nodes) return;
    const counts = {};
    for (const t of S.turns) counts[t.nodeId] = (counts[t.nodeId] || 0) + 1;
    if (!S.nodes.length) { put(clear(root), h('div', { class: 'notice' }, '大纲还没有写入数据库。请让 Claude 按 spec 附录 A 用 ArtifactData 写入种子数据。')); return; }
    const p1 = S.nodes.filter(n => n.priority === 1);
    const lastId = ls.get('lastNode');
    const blocks = TRACKS.map(tr => {
      const ns = S.nodes.filter(n => n.track === tr.id);
      if (!ns.length) return null;
      return h('section', { class: 'track' },
        h('div', { class: 'track-head' }, h('h3', null, tr.name + ' · ' + tr.sub), h('span', { class: 'small muted' }, ns.filter(n => n.status === 'done').length + '/' + ns.length + ' 已盖章')),
        h('ul', { class: 'node-list' }, ns.map(n => h('li', null,
          h('button', { class: 'node-row' + (n.id === lastId ? ' is-current' : ''), type: 'button', onclick: () => openNode(n.id) },
            h('span', { class: 'nid' }, n.id),
            h('span', { class: 'nt' }, n.title_zh),
            h('span', { class: 'nq' }, n.main_q || (arr(n.listen).length + ' 条听力')),
            h('span', { class: 'nr' }, stampEl(n.status), h('span', { class: 'small muted' }, 'P' + n.priority + ' · ' + (counts[n.id] || 0) + ' 条')))))));
    });
    put(clear(root), 
      h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, '场景大纲'), h('span', { class: 'small muted' }, '出发前必练 ' + p1.filter(n => n.status === 'done').length + '/' + p1.length + ' 已盖章')),
      profileNudge(), ...blocks);
  }

  function profileNudge() {
    if (S.profile || !S.loaded.profile) return null;
    return h('div', { class: 'notice info' }, '先在设置里确认"我的素材"（住哪、做什么、为什么来），追问和口袋本会更贴近你。 ',
      h('button', { class: 'link-btn', type: 'button', onclick: () => App.go('settings') }, '去确认'));
  }

  /* ---------------- 节点页 ---------------- */
  function initialQ(node) {
    const sid = Sessions.currentId;
    const last = sid ? Data.sessionTurns(sid).filter(t => t.nodeId === node.id && t.mode === 'drill').slice(-1)[0] : null;
    return (last && last.followup) || node.main_q || '';
  }

  function openNode(id, keepScroll) {
    const node = S.nodeMap[id];
    if (!node) return;
    if (cur && cur.ctl) cur.ctl.abort();
    if (cur && cur.voice) cur.voice.stop();
    ls.set('lastNode', id);
    cur = {
      id, node, mode: ls.get('mode:' + id, 'drill'), q: initialQ(node), qIdx: 0,
      busy: false, ctl: null, voice: null, voiceRec: null, els: {},
      convo: ls.get('convo:' + id, null),
    };
    const els = cur.els;
    const listening = node.track === 'listening';
    els.head = h('div', { class: 'node-head' });
    refreshHead();
    const parts = [els.head, buildListen(node, listening)];
    if (!listening) {
      els.seg = h('div', { class: 'seg', role: 'group', 'aria-label': '练习方式' },
        h('button', { type: 'button', 'aria-pressed': String(cur.mode === 'drill'), onclick: () => setMode('drill') }, '逐句反馈'),
        h('button', { type: 'button', 'aria-pressed': String(cur.mode === 'convo'), onclick: () => setMode('convo') }, '实战对话'));
      els.drill = buildDrill();
      els.convo = h('div', { class: 'stack' });
      els.drill.hidden = cur.mode !== 'drill';
      els.convo.hidden = cur.mode !== 'convo';
      parts.push(els.seg, els.drill, els.convo);
      renderConvo();
    }
    els.foot = h('div', { class: 'stack' });
    renderFoot();
    parts.push(els.foot);
    put(clear(root), ...parts);
    if (!keepScroll) window.scrollTo(0, 0);
    Bus.emit('nodeOpened', id);
  }

  function backToList() {
    if (cur && cur.ctl) cur.ctl.abort();
    if (cur && cur.voice) cur.voice.stop();
    cur = null;
    renderList();
    window.scrollTo(0, 0);
  }

  function refreshHead() {
    if (!cur) return;
    const n = cur.node;
    const tr = TRACKS.find(t => t.id === n.track);
    const count = Data.turnsOfNode(n.id).length;
    put(clear(cur.els.head), 
      h('button', { class: 'link-btn', type: 'button', onclick: backToList }, '← 全部场景'),
      h('h2', null, h('span', { class: 'nid' }, n.id), n.title_zh, stampEl(n.status)),
      h('p', { class: 'small muted' }, (tr ? tr.name : n.track) + ' · P' + n.priority + (n.track === 'listening' ? '' : ' · 已答 ' + count + ' 条')));
  }

  function phrase(en, zh, note, tts) {
    return h('div', { class: 'phrase' },
      h('p', { class: 'en-s' }, en),
      zh || note ? h('p', { class: 'zh' }, zh || '', note ? h('span', { class: 'note' }, (zh ? ' · ' : '') + note) : null) : null,
      tts === false ? h('span') : sayBtn(en));
  }
  function buildListen(node, open) {
    const sec = (title, kids) => h('div', { class: 'stack-s' }, h('p', { class: 'label' }, title), h('div', { class: 'phrase-list' }, kids));
    const secs = [];
    const asks = [node.main_q, ...arr(node.variants)].filter(Boolean);
    if (asks.length) secs.push(sec(node.track === 'service' ? '对方可能这样说' : '别人可能这样问', asks.map(t => phrase(t))));
    if (arr(node.say).length) secs.push(sec('你要说的', node.say.map(t => phrase(t))));
    if (arr(node.listen).length) secs.push(sec('可能听到', node.listen.map(l => phrase(l.en, l.zh, l.note, l.tts))));
    if (arr(node.tips_zh).length) secs.push(h('div', { class: 'stack-s' }, h('p', { class: 'label' }, '小提示'), h('ul', { class: 'tips' }, node.tips_zh.map(t => h('li', null, t)))));
    const hasTurns = Data.turnsOfNode(node.id).length > 0;
    return h('details', { class: 'listen', open: open || !hasTurns }, h('summary', null, '听懂'), h('div', { class: 'listen-body' }, secs));
  }

  function setMode(m) {
    if (!cur || cur.busy) return;
    cur.mode = m; ls.set('mode:' + cur.id, m);
    cur.els.seg.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === (m === 'drill'))));
    cur.els.drill.hidden = m !== 'drill';
    cur.els.convo.hidden = m !== 'convo';
  }

  /* ---------------- 逐句反馈 ---------------- */
  function buildDrill() {
    const els = cur.els, node = cur.node;
    const pane = h('div', { class: 'stack' });
    els.thread = h('div', { class: 'thread' });
    const sid = Sessions.currentId;
    if (sid) Data.sessionTurns(sid).filter(t => t.nodeId === node.id && t.mode === 'drill').forEach(t => put(els.thread, turnCard(t)));

    els.qText = h('p', { class: 'en' });
    els.reveal = h('button', { class: 'link-btn', type: 'button', onclick: () => { els.qText.classList.remove('hidden-text'); els.reveal.hidden = true; } }, '显示文字');
    const variants = [node.main_q, ...arr(node.variants)].filter(Boolean);
    const lf = h('input', { type: 'checkbox', id: 'listen-first', checked: !!ls.get('listenFirst', false), onchange: e => ls.set('listenFirst', e.target.checked) });
    els.qBubble = h('div', { class: 'bubble them' },
      h('span', { class: 'who' }, node.track === 'service' ? '工作人员' : '旅伴'),
      h('div', { class: 'q-line' }, els.qText, sayBtn(() => cur.q)),
      h('div', { class: 'q-actions' }, els.reveal,
        variants.length > 1 ? h('button', { class: 'link-btn', type: 'button', onclick: () => { cur.qIdx = (cur.qIdx + 1) % variants.length; setQ(variants[cur.qIdx], true); } }, '换个问法') : null,
        h('label', { class: 'check tts-only', for: 'listen-first' }, lf, '先听后看')));

    const pane2 = [els.thread, els.qBubble];
    if (!Platform.llm.available) {
      pane2.push(llmNotice());
    } else {
      els.ta = h('textarea', {
        id: 'drill-answer', class: 'en', rows: 3, placeholder: '用输入法的语音输入回答；卡住的词直接说中文；别手动改',
        oninput: () => ls.set('draft:' + cur.id, els.ta.value),
      });
      els.ta.value = ls.get('draft:' + node.id, '') || '';
      els.status = h('div', { class: 'status', role: 'status' });
      els.stop = h('button', { class: 'btn ghost small', type: 'button', hidden: true, onclick: () => cur.ctl && cur.ctl.abort() }, '停止');
      els.send = h('button', { class: 'btn', type: 'button', onclick: sendDrill }, '发送');
      els.mic = Voice.enabled() ? h('button', { class: 'mic-btn', type: 'button', 'aria-label': '说一次就够：页面内语音识别', onclick: toggleVoice }, icon('mic')) : null;
      els.problem = h('div', { class: 'stack-s', hidden: true });
      pane2.push(h('div', { class: 'composer' }, els.ta, h('div', { class: 'composer-row' }, els.mic, els.status, els.stop, els.send), els.problem));
    }
    put(pane, ...pane2);
    setQ(cur.q, false);
    return pane;
  }

  function setQ(q, fresh) {
    cur.q = q || cur.node.main_q || '';
    const els = cur.els;
    els.qText.textContent = cur.q;
    const hide = fresh && ls.get('listenFirst', false) && TTS.available;
    els.qText.classList.toggle('hidden-text', !!hide);
    els.reveal.hidden = !hide;
    if (hide) TTS.speak(cur.q);
  }

  function setBusy(b, msg) {
    cur.busy = b;
    const els = cur.els;
    if (els.send) els.send.disabled = b;
    if (els.stop) els.stop.hidden = !b;
    if (els.status) put(clear(els.status), b ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : null, msg || '');
  }

  function showProblem(e, retry) {
    const box = cur.els.problem;
    if (!box) return;
    clear(box);
    if (!e) { box.hidden = true; return; }
    box.hidden = false;
    put(box, h('div', { class: e.code === 'rate_limited' ? 'notice' : 'notice bad' }, sampleErrZh(e.code)));
    if (e.text) put(box, h('details', null, h('summary', { class: 'small muted' }, '查看 Claude 的原文'), h('pre', { class: 'raw-reply' }, e.text)));
    if (retry && (e.code === 'invalid_json' || e.code === 'bad_shape' || e.code === 'upstream_error' || e.code === 'empty_completion')) {
      put(box, h('div', null, h('button', { class: 'btn ghost small', type: 'button', onclick: retry }, '重试')));
    }
  }

  function drillPrompt(node, q, raw, sid) {
    const facts = Data.profileFacts();
    const hist = sid ? Data.sessionTurns(sid).filter(t => t.nodeId === node.id && t.mode === 'drill').slice(-6) : [];
    return fill(PROMPTS.drill, {
      title_zh: node.title_zh, main_q: node.main_q || '',
      profile_facts: facts.length ? facts.map(f => '- ' + f).join('\n') : '(none yet)',
      history: hist.length ? hist.map(t => 'Q: ' + t.q + '\nA: ' + t.raw).join('\n') : '(none)',
      q, raw, rules: RULES_1_TO_3,
      role: DRILL_ROLE[node.track] || DRILL_ROLE.social,
      followups: arr(node.followups).length ? node.followups.join(' / ') : '(none)',
    });
  }

  async function sendDrill() {
    if (!cur || cur.busy) return;
    const c = cur, els = c.els, node = c.node;
    const raw = els.ta.value.trim();
    if (!raw) { els.ta.focus(); return; }
    if (c.voice) c.voice.stop();
    ls.set('draft:' + c.id, raw);
    showProblem(null);
    const ctl = new AbortController();
    c.ctl = ctl;
    setBusy(true, 'Thinking…');
    let fb;
    try {
      const sid = await Sessions.ensure();
      const res = await Platform.llm.json(drillPrompt(node, c.q, raw, sid), { tier: 'default', cache: false, signal: ctl.signal });
      fb = cleanFeedback(res);
      const turn = {
        nodeId: node.id, sessionId: sid, mode: 'drill', q: c.q, raw,
        corrected: fb.corrected, natural: fb.natural, errors: fb.errors, asked_back: fb.asked_back,
        n_words: countWords(raw), vocab: fb.vocab, followup: fb.followup || null, persona: null, createdAt: nowIso(),
      };
      const id = uid('t');
      if (cur !== c) return;
      put(els.thread, turnCard(Object.assign({ id }, turn)));
      try {
        await Platform.store.set('turns/' + id, turn);
        ls.del('draft:' + c.id);
        if (cur === c) els.ta.value = '';
        setBusy(false, '');
      } catch (e) {
        setBusy(false, '');
        showProblem({ code: 'upstream_error' });
        toast('这条没存上（' + (e.code || '出错') + '），原话留在输入框里了');
      }
      for (const v of fb.vocab) Platform.store.set('vocab/' + uid('v'), { zh: v.zh, en: v.en, example: v.example, nodeId: node.id, createdAt: nowIso() }).catch(() => {});
      if (!node.status || node.status === 'todo') Platform.store.update('nodes/' + node.id, { status: 'doing' }).catch(() => {});
      if (c.voiceRec) { const vr = c.voiceRec; c.voiceRec = null; Record.saveRecording({ blob: vr.blob, recMime: vr.mime, durationSec: vr.durationSec, prompt: c.q, nodeId: node.id, turnId: id, fixedPrompt: null }).catch(() => toast('顺带的录音没传上去')); }
      if (cur === c) {
        setQ(fb.followup || node.main_q, true);
        els.qBubble.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    } catch (e) {
      if (cur !== c) return;
      setBusy(false, e.code === 'cancelled' ? '已停止。原话还在输入框里。' : '');
      if (e.code !== 'cancelled') showProblem(e, sendDrill);
    } finally {
      if (cur === c) { c.ctl = null; if (c.busy) setBusy(false, ''); }
    }
  }

  function toggleVoice() {
    const c = cur;
    if (!c || c.busy) return;
    if (c.voice) { c.voice.stop(); return; }
    c.els.mic.classList.add('live');
    setBusy(false, Voice.withRecording() ? '在听，也在录音……再点一下结束' : '在听……再点一下结束');
    Voice.start(c.els.ta, st => {
      c.voice = null;
      if (c.els.mic) c.els.mic.classList.remove('live');
      if (st.blob) c.voiceRec = { blob: st.blob, mime: st.mime, durationSec: st.durationSec };
      if (st.error && st.error !== 'no-speech' && st.error !== 'aborted') {
        setBusy(false, '语音识别出错：' + st.error + '。可以改用输入法的语音输入。');
        if (ls.get('voiceBlocked', false) && c.els.mic) { c.els.mic.remove(); c.els.mic = null; }
      } else setBusy(false, c.voiceRec ? '说完了。确认没问题就发送（录音会一起存下）' : '');
    }).then(v => { c.voice = v; });
  }

  /* ---------------- 实战对话 ---------------- */
  const personaOf = id => S.personas.find(p => p.id === id) || null;
  const learnerCount = c => (c ? c.msgs.filter((m, i) => i > 0 && m.role === 'user').length : 0);
  function saveConvo() { if (cur) ls.set('convo:' + cur.id, cur.convo); }
  function trimMsgs(msgs) {
    const out = msgs.map(m => ({ role: m.role, content: m.content }));
    const enc = new TextEncoder();
    const size = () => out.reduce((a, m) => a + enc.encode(m.content).length, 0);
    while (out.length > 3 && size() > 48000) out.splice(1, 1);
    return out;
  }

  function renderConvo() {
    if (!cur || !cur.els.convo) return;
    const pane = clear(cur.els.convo), c = cur.convo;
    if (!Platform.llm.available) { put(pane, llmNotice()); return; }
    if (!c) {
      if (!S.personas.length) { put(pane, h('p', { class: 'muted' }, S.loaded.personas ? '还没有角色。' : '正在读取角色……')); return; }
      put(pane, h('p', { class: 'small muted' }, '选一个人聊 8 到 10 轮。过程中不纠错，结束后统一讲评。'),
        h('div', { class: 'persona-grid' }, S.personas.map(p => h('button', { class: 'persona', type: 'button', onclick: () => startConvo(p) },
          h('span', { class: 'pn' }, p.name, h('span', { class: 'chip ' + (p.native ? 'accent' : '') }, p.native ? '母语' : p.fluent ? '非母语 · 流利' : '非母语')),
          h('span', { class: 'pb' }, p.bio_zh || p.bio),
          h('span', { class: 'ps' }, '场景：' + (p.setting_zh || p.setting))))));
      return;
    }
    const p = personaOf(c.personaId) || { name: c.personaName || '对方', setting_zh: '' };
    const n = learnerCount(c);
    put(pane, h('div', { class: 'row-between' },
      h('div', null, h('b', null, '和 ' + p.name + ' 聊天'), h('p', { class: 'small muted' }, p.setting_zh || '')),
      h('button', { class: 'btn quiet small', type: 'button', onclick: resetConvo }, c.debrief ? '换个人再聊' : '换人')));
    const thread = h('div', { class: 'thread' });
    c.msgs.forEach((m, i) => { if (i === 0) return; put(thread, m.role === 'assistant' ? bubbleThem(m.content, p.name) : bubbleMe(m.content)); });
    cur.els.convoLive = h('p', { class: 'en' });
    const liveBubble = h('div', { class: 'bubble them', hidden: true }, h('span', { class: 'who' }, p.name), cur.els.convoLive);
    cur.els.convoLiveBubble = liveBubble;
    put(thread, liveBubble);
    put(pane, thread);

    if (c.debrief) { put(pane, debriefView(c)); return; }

    const lastIsUser = c.msgs[c.msgs.length - 1].role === 'user';
    cur.els.cta = h('textarea', { id: 'convo-answer', class: 'en', rows: 3, placeholder: '用输入法的语音输入回答；卡住的词直接说中文；别手动改', oninput: () => ls.set('cdraft:' + cur.id, cur.els.cta.value) });
    cur.els.cta.value = ls.get('cdraft:' + cur.id, '') || '';
    cur.els.cstatus = h('div', { class: 'status', role: 'status' }, n >= 8 ? '聊得差不多了，可以结束看讲评。' : '第 ' + n + ' 轮（8 到 10 轮后讲评）');
    cur.els.cstop = h('button', { class: 'btn ghost small', type: 'button', hidden: true, onclick: () => cur.ctl && cur.ctl.abort() }, '停止');
    cur.els.csend = h('button', { class: 'btn', type: 'button', onclick: convoSend }, '发送');
    cur.els.cproblem = h('div', { class: 'stack-s' });
    put(pane, h('div', { class: 'composer' },
      cur.els.cta,
      h('div', { class: 'composer-row' }, cur.els.cstatus, cur.els.cstop, cur.els.csend),
      cur.els.cproblem,
      h('div', { class: 'row' },
        lastIsUser ? h('button', { class: 'btn ghost small', type: 'button', onclick: () => personaReply() }, '让对方重新回复') : null,
        n > 0 ? h('button', { class: 'btn ghost small', type: 'button', onclick: runDebrief }, '结束对话，看讲评') : null)));
  }

  function convoBusy(b, msg) {
    cur.busy = b;
    const e = cur.els;
    if (e.csend) e.csend.disabled = b;
    if (e.cstop) e.cstop.hidden = !b;
    if (e.cstatus) put(clear(e.cstatus), b ? h('span', { class: 'spin', 'aria-hidden': 'true' }) : null, msg || '');
  }
  function convoProblem(err) {
    const box = cur && cur.els.cproblem;
    if (!box) return;
    clear(box);
    if (err && err.code !== 'cancelled') {
      put(box, h('div', { class: err.code === 'rate_limited' ? 'notice' : 'notice bad' }, sampleErrZh(err.code)));
      if (err.text) put(box, h('details', null, h('summary', { class: 'small muted' }, '查看 Claude 的原文'), h('pre', { class: 'raw-reply' }, err.text)));
    }
  }

  async function startConvo(p) {
    if (!cur || cur.busy) return;
    const instr = fill(PROMPTS.convo, { name: p.name, bio: p.bio, setting: p.setting, style: p.native ? '' : NON_NATIVE_STYLE });
    cur.convo = { personaId: p.id, personaName: p.name, msgs: [{ role: 'user', content: instr, at: nowIso() }], debrief: null, saved: false, startedAt: nowIso() };
    saveConvo();
    renderConvo();
    await personaReply();
  }

  function resetConvo() {
    if (!cur || cur.busy) return;
    cur.convo = null; saveConvo(); ls.del('cdraft:' + cur.id);
    renderConvo();
  }

  async function personaReply() {
    const c = cur;
    if (!c || !c.convo || c.busy) return;
    const cv = c.convo;
    const ctl = new AbortController();
    c.ctl = ctl;
    convoBusy(true, 'Thinking…');
    convoProblem(null);
    if (c.els.convoLiveBubble) { c.els.convoLiveBubble.hidden = false; c.els.convoLive.textContent = '…'; }
    try {
      const r = await Platform.llm.text(trimMsgs(cv.msgs), { tier: 'quick', cache: false, signal: ctl.signal, onText: ({ text }) => { if (c.els.convoLive) c.els.convoLive.textContent = text; } });
      cv.msgs.push({ role: 'assistant', content: r.text.trim(), at: nowIso() });
      saveConvo();
    } catch (e) {
      if (cur === c) { c.busy = false; renderConvo(); convoProblem(e); }
      return;
    } finally { c.ctl = null; c.busy = false; }
    if (cur !== c) return;
    renderConvo();
    if (cur.els.cta) cur.els.cta.focus({ preventScroll: true });
    if (learnerCount(cv) >= 10) await runDebrief();
  }

  async function convoSend() {
    const c = cur;
    if (!c || !c.convo || c.busy) return;
    const text = c.els.cta.value.trim();
    if (!text) { c.els.cta.focus(); return; }
    c.convo.msgs.push({ role: 'user', content: text, at: nowIso() });
    saveConvo(); ls.del('cdraft:' + c.id);
    renderConvo();
    Sessions.ensure().catch(() => {});
    await personaReply();
  }

  async function runDebrief() {
    const c = cur;
    if (!c || !c.convo || c.busy) return;
    const cv = c.convo;
    const p = personaOf(cv.personaId) || { id: cv.personaId, name: cv.personaName || 'P' };
    const lines = [], learner = [];
    cv.msgs.forEach((m, i) => {
      if (i === 0) return;
      if (m.role === 'assistant') lines.push('P: ' + m.content);
      else { learner.push(i); lines.push('L' + learner.length + ': ' + m.content); }
    });
    if (!learner.length) return;
    const ctl = new AbortController();
    c.ctl = ctl;
    convoBusy(true, '讲评中…… Thinking…');
    convoProblem(null);
    try {
      const r = await Platform.llm.json(fill(PROMPTS.debrief, { name: p.name, rules: RULES_1_TO_3, transcript_lines: lines.join('\n') }), { tier: 'default', cache: false, signal: ctl.signal });
      if (!r || typeof r !== 'object' || !Array.isArray(r.turns)) throw { code: 'bad_shape', text: JSON.stringify(r) };
      const perTurn = learner.map((mi, k) => {
        const t = r.turns.find(x => x && Number(x.i) === k + 1) || r.turns[k] || {};
        let natural = t.natural == null ? null : (str(t.natural) || null);
        const corrected = str(t.corrected) || cv.msgs[mi].content;
        if (natural && normText(natural) === normText(corrected)) natural = null;
        return { corrected, errors: cleanErrors(t.errors), natural };
      });
      const s = r.summary && typeof r.summary === 'object' ? r.summary : {};
      const summary = {
        top: arr(s.top).map(x => x && ({ type: ERROR_MAP[str(x.type).toUpperCase()] ? str(x.type).toUpperCase() : 'STRUCT', count: Number(x.count) || 0, example_orig: str(x.example_orig), example_fix: str(x.example_fix) })).filter(Boolean).slice(0, 3),
        strengths_zh: str(s.strengths_zh), rule_zh: str(s.rule_zh),
        next_focus_zh: Array.isArray(s.next_focus_zh) ? s.next_focus_zh.map(str).filter(Boolean) : str(s.next_focus_zh) ? [str(s.next_focus_zh)] : [],
      };
      cv.debrief = { perTurn, summary, at: nowIso() };
      saveConvo();
      const sid = await Sessions.ensure();
      for (let k = 0; k < learner.length; k++) {
        const mi = learner[k], m = cv.msgs[mi];
        const prev = cv.msgs[mi - 1] && cv.msgs[mi - 1].role === 'assistant' ? cv.msgs[mi - 1].content : '';
        const next = cv.msgs[mi + 1] && cv.msgs[mi + 1].role === 'assistant' ? cv.msgs[mi + 1].content : null;
        const pt = perTurn[k];
        await Platform.store.set('turns/' + uid('t'), {
          nodeId: c.id, sessionId: sid, mode: 'convo', q: prev, raw: m.content,
          corrected: pt.corrected, natural: pt.natural, errors: pt.errors,
          asked_back: /\?\s*$/.test(m.content) || /\?\s*$/.test(pt.corrected),
          n_words: countWords(m.content), vocab: [], followup: next, persona: p.id, createdAt: m.at || nowIso(),
        });
      }
      cv.saved = true;
      saveConvo();
      if (!c.node.status || c.node.status === 'todo') Platform.store.update('nodes/' + c.id, { status: 'doing' }).catch(() => {});
    } catch (e) {
      if (cur === c) { c.busy = false; renderConvo(); convoProblem(e.code ? e : { code: 'upstream_error' }); }
      return;
    } finally { c.ctl = null; c.busy = false; }
    if (cur === c) renderConvo();
  }

  function debriefView(c) {
    const d = c.debrief, box = h('div', { class: 'card stack' }, h('h3', { class: 'section-title' }, '讲评'));
    let k = 0;
    c.msgs.forEach((m, i) => {
      if (i === 0 || m.role !== 'user') return;
      const pt = d.perTurn[k++] || { corrected: m.content, errors: [], natural: null };
      put(box, h('div', { class: 'debrief-turn' },
        bubbleMe(m.content),
        h('div', { class: 'fb' }, fbRow('改后', pt.corrected, 'corrected'), errorsBlock(pt.errors), pt.natural ? fbRow('更自然', pt.natural) : null)));
    });
    const s = d.summary || {};
    put(box, h('div', { class: 'stack-s' },
      h('p', { class: 'label' }, '总结'),
      arr(s.top).length ? h('ul', { class: 'stack-s' }, s.top.map(t => h('li', null, h('b', null, (ERROR_MAP[t.type] ? ERROR_MAP[t.type].name : t.type) + ' ×' + t.count), ' ', h('span', { class: 'en-s' }, t.example_orig ? h('s', null, t.example_orig) : null, t.example_orig ? ' → ' : '', t.example_fix)))) : null,
      s.strengths_zh ? h('p', null, '做得好：' + s.strengths_zh) : null,
      s.rule_zh ? h('p', { class: 'notice info' }, h('b', null, '口诀：'), s.rule_zh) : null,
      arr(s.next_focus_zh).length ? h('p', null, '下次重点：' + s.next_focus_zh.join('；')) : null,
      h('p', { class: 'small muted' }, c.saved ? '这次对话的每条回答都已记进错误统计。' : '')));
    return box;
  }

  /* ---------------- 底部：盖章、结束本次练习 ---------------- */
  function renderFoot(result) {
    if (!cur) return;
    if (result !== undefined) cur.footResult = result;
    const node = cur.node, foot = clear(cur.els.foot);
    if (cur.footResult) put(foot, cur.footResult);
    if (node.track === 'listening') {
      put(foot, h('div', { class: 'node-foot' },
        node.status === 'done' ? h('span', { class: 'small muted' }, '已经听熟了。') :
          h('button', { class: 'btn ghost', type: 'button', onclick: () => Platform.store.update('nodes/' + node.id, { status: 'done' }).then(() => toast('已盖章'), e => toast('没存上：' + e.code)) }, '听熟了，盖章')));
      return;
    }
    put(foot, h('div', { class: 'node-foot' },
      h('button', { class: 'btn ghost', type: 'button', onclick: () => finishNode(false) }, node.status === 'done' ? '重新整理口袋本' : '这个节点练完了'),
      Sessions.currentId ? h('button', { class: 'btn ghost', type: 'button', onclick: () => App.endSession() }, '结束本次练习') : null));
  }

  async function finishNode(force) {
    const c = cur;
    if (!c || c.busy) return;
    const node = c.node;
    const answers = Data.turnsOfNode(node.id).map(t => t.corrected).filter(Boolean).slice(-12);
    const stampOnly = () => Platform.store.update('nodes/' + node.id, { status: 'done' }).then(() => { toast('已盖章'); renderFoot(null); }, e => toast('没存上：' + e.code));
    if (!answers.length) { toast('先练几句，再整理口袋本'); return; }
    if (!Platform.llm.available) { await stampOnly(); return; }
    const existing = S.bank[node.id];
    if (existing && existing.edited && !force) {
      renderFoot(h('div', { class: 'notice' }, '口袋本里这一条你改过。重新生成会覆盖你的修改。',
        h('div', { class: 'row', style: 'margin-top:8px' },
          h('button', { class: 'btn small', type: 'button', onclick: () => finishNode(true) }, '覆盖'),
          h('button', { class: 'btn ghost small', type: 'button', onclick: stampOnly }, '只盖章，不覆盖'))));
      return;
    }
    c.busy = true;
    renderFoot(h('p', { class: 'status' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), ' 正在整理最佳回答…… Thinking…'));
    try {
      const facts = Data.profileFacts();
      const r = await Platform.llm.json(fill(PROMPTS.bank, {
        title_zh: node.title_zh, main_q: node.main_q || '', profile_facts: facts.length ? facts.join('; ') : '(none)',
        corrected_answers: '\n' + answers.map(a => '- ' + a).join('\n'),
      }), { tier: 'default', cache: false });
      const best_en = str(r && r.best_en);
      if (!best_en) throw { code: 'bad_shape', text: JSON.stringify(r) };
      const chunks = arr(r.chunks).map(x => x && ({ en: str(x.en), zh: str(x.zh) })).filter(x => x && x.en).slice(0, 8);
      await Platform.store.set('bank/' + node.id, { best_en, chunks, updatedAt: nowIso(), edited: false });
      await Platform.store.update('nodes/' + node.id, { status: 'done' });
      if (cur !== c) return;
      renderFoot(h('div', { class: 'card stack' },
        h('p', { class: 'label' }, '已盖章 · 存进口袋本'),
        h('div', { class: 'q-line row' }, h('p', { class: 'en', style: 'flex:1' }, best_en), sayBtn(best_en)),
        h('div', { class: 'chunks' }, chunks.map(x => h('div', { class: 'chunk' }, h('span', { class: 'en-s' }, x.en), h('span', { class: 'zh' }, x.zh), sayBtn(x.en)))),
        h('button', { class: 'link-btn', type: 'button', onclick: () => App.go('pocket') }, '去口袋本看看')));
    } catch (e) {
      if (cur === c) renderFoot(h('div', { class: 'notice bad' }, sampleErrZh(e.code || 'upstream_error'), ' ', h('button', { class: 'link-btn', type: 'button', onclick: () => finishNode(force) }, '重试')));
    } finally { c.busy = false; }
  }

  Bus.on('session', () => { if (cur) renderFoot(); });

  return {
    init, show, openNode,
    get currentNodeId() { return cur ? cur.id : ls.get('lastNode'); },
  };
})();
