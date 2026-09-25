/* =====================================================================
 * 设置：我的素材、练习偏好、导出全部数据、诊断（M0 探针）、关于
 * ===================================================================== */

const Settings = (() => {
  let root = null, built = false;
  const els = {};

  function init(el) {
    root = el;
    Bus.on('profile', () => { if (built) renderProfile(); });
    Bus.on('profileDraft', () => { if (built) renderProfile(); });
    Bus.on('config', () => { if (built) renderAbout(); });
    TTS.onChange(() => { if (built) renderPrefs(); });
  }

  function show(anchor) {
    if (!built) build();
    renderProfile(); renderPrefs(); renderAbout();
    if (anchor === 'probe' && els.probeCard) els.probeCard.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  }
  function hide() {}

  function build() {
    built = true;
    els.profile = h('section', { class: 'card stack' });
    els.prefs = h('section', { class: 'card stack' });
    els.data = h('section', { class: 'card stack' });
    els.probe = h('div');
    els.probeCard = h('section', { class: 'card stack', id: 'probe' }, h('h2', { class: 'section-title' }, '诊断'), h('p', { class: 'small muted' }, '检测这台设备能不能在页面里录音、上传、调用 Claude、朗读和语音识别。换设备或换 App 时再测一次。'), els.probe);
    els.about = h('section', { class: 'card stack' });
    put(clear(root),
      h('div', { class: 'row-between' }, h('button', { class: 'link-btn', type: 'button', onclick: () => App.back() }, '← 返回'), h('h2', { class: 'section-title' }, '设置')),
      els.profile, els.prefs, els.data, els.probeCard, els.about);
    renderData();
    Probe.mount(els.probe);
  }

  /* ---------------- 我的素材 ---------------- */
  function renderProfile() {
    const confirmed = !!S.profile;
    const facts = confirmed ? arr(S.profile.facts) : arr(S.profileDraft && S.profileDraft.facts);
    const ta = h('textarea', { id: 'profile-facts', rows: 7 });
    ta.value = facts.join('\n');
    const save = async () => {
      const list = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
      try { await Platform.store.set('me/profile', { facts: list, updatedAt: nowIso() }); toast('已保存'); }
      catch (e) { toast('没存上：' + (e.code || e)); }
    };
    put(clear(els.profile),
      h('h2', { class: 'section-title' }, '我的素材'),
      h('p', { class: 'small muted' }, '一行写一条关于你自己的事实。页面内 Claude 只在追问和整理口袋本时用它，让你前后说的一致。'),
      confirmed ? null : h('div', { class: 'notice' }, '下面是根据已知信息预填的草稿，还没生效。确认或修改后点"保存"。"老家"那条记得填上。'),
      ta,
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: save }, confirmed ? '保存' : '确认并保存'),
        confirmed && S.profile.updatedAt ? h('span', { class: 'small muted' }, '上次保存 ' + fmtWhen(S.profile.updatedAt)) : null));
  }

  /* ---------------- 偏好（存在本机） ---------------- */
  function select(id, value, options, onchange) {
    const s = h('select', { id, onchange: e => onchange(e.target.value) }, options.map(([v, t]) => h('option', { value: v }, t)));
    s.value = value;
    return s;
  }
  function field(label, control, hint) {
    return h('div', { class: 'stack-s' }, h('label', { class: 'small', for: control.id, style: 'font-weight:600' }, label), control, hint ? h('p', { class: 'small muted' }, hint) : null);
  }
  function renderPrefs() {
    const voices = TTS.voices;
    const hasSR = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    const pf = Probe.flags();
    put(clear(els.prefs),
      h('h2', { class: 'section-title' }, '练习偏好'),
      h('p', { class: 'small muted' }, '这些设置只存在这台设备上。'),
      h('label', { class: 'check', for: 'pref-listen-first' },
        h('input', { type: 'checkbox', id: 'pref-listen-first', checked: !!ls.get('listenFirst', false), onchange: e => ls.set('listenFirst', e.target.checked) }),
        '先听后看：新问题先朗读，点一下才显示文字'),
      voices.length ? field('朗读语音', select('pref-voice', TTS.voice ? TTS.voice.voiceURI : '', voices.map(v => [v.voiceURI, v.name + '（' + v.lang + '）']), v => TTS.setVoice(v))) :
        h('p', { class: 'small muted' }, '这台设备没有英文朗读语音，朗读按钮已隐藏。'),
      voices.length ? field('朗读语速', select('pref-rate', String(ls.get('ttsRate', 0.95)), [['0.95', '正常'], ['0.8', '慢一点'], ['0.65', '很慢']], v => ls.set('ttsRate', Number(v)))) : null,
      field('说一次就够（页面内语音识别）', select('pref-voice-mode', Voice.mode(), [['auto', '自动：诊断第 7 项通过才显示'], ['on', '总是显示麦克风按钮'], ['off', '关闭']], v => { ls.set('voiceMode', v); ls.del('voiceBlocked'); }),
        !hasSR ? '这个浏览器没有语音识别 API（比如平板没有谷歌服务），会自动隐藏。' : '诊断结果：第 7 项 ' + (pf.asr ? (pf.asr === 'pass' ? '通过' : '失败') : '未测') + '，第 8 项 ' + (pf.asrWithRec ? (pf.asrWithRec === 'pass' ? '通过' : '失败') : '未测') + '。改动后重新打开节点生效。'),
      field('录音方式', select('pref-rec-route', ls.get('recRoute') || 'auto', [['auto', '自动'], ['page', '页面里录'], ['file', '系统录音机或选文件']], v => { if (v === 'auto') ls.del('recRoute'); else ls.set('recRoute', v); ls.del('micBlocked'); })));
  }

  /* ---------------- 数据 ---------------- */
  function renderData() {
    const status = h('p', { class: 'small muted', role: 'status' });
    const btn = h('button', { class: 'btn ghost', type: 'button', onclick: async () => {
      if (!Platform.store.available) { toast('数据库不可用'); return; }
      btn.disabled = true; status.textContent = '正在读取全部数据……';
      try {
        const data = await collectAll();
        status.textContent = '共 ' + Object.values(data.collections).reduce((a, x) => a + x.length, 0) + ' 个文档，等你确认保存……';
        const r = await Platform.blobs.saveFile('口语特训-数据-' + localDate() + '.json', JSON.stringify(data, null, 1));
        status.textContent = r && r.status === 'delivered' ? '已交出。' : '已保存。';
      } catch (e) {
        status.textContent = e.code === 'declined' ? '已取消。' : '导出失败：' + (e.code || e.message || e);
      } finally { btn.disabled = false; }
    } }, '导出全部数据（JSON）');
    put(clear(els.data),
      h('h2', { class: 'section-title' }, '数据'),
      h('p', { class: 'small muted' }, '把所有记录导出成一个 JSON 文件：既是备份，也是以后换成独立 App 时的数据来源。录音文件本身不在里面。'),
      Platform.blobs.canSave ? h('div', null, btn) : h('p', { class: 'small muted' }, '这个视图不能保存文件。'),
      status);
  }

  async function collectAll() {
    const st = Platform.store;
    const byField = { turns: 'createdAt', recordings: 'createdAt', sessions: 'startedAt', vocab: 'createdAt', probe: 'ts' };
    const plain = ['nodes', 'bank', 'personas', 'config'];
    const out = { app: '口语特训', version: APP_VERSION, exportedAt: nowIso(), artifactUrl: S.config.artifactUrl || '', collections: {} };
    for (const c of plain) out.collections[c] = await st.query(c, { limit: 1000 });
    for (const [c, f] of Object.entries(byField)) out.collections[c] = await st.queryAll(c, f);
    const me = await st.get('me/profile');
    out.collections.me = me ? [me] : [];
    return out;
  }

  /* ---------------- 关于 ---------------- */
  function renderAbout() {
    const url = S.config.artifactUrl || '';
    const code = h('code', null, url || '（未设置）');
    put(clear(els.about),
      h('h2', { class: 'section-title' }, '关于'),
      h('dl', { class: 'kv' },
        h('dt', null, '版本'), h('dd', { class: 'mono' }, APP_VERSION),
        h('dt', null, '文档数'), h('dd', null, [S.nodes.length + ' 节点', S.turns.length + ' 回答', S.recordings.length + ' 录音', S.sessions.length + ' 场次', S.vocab.length + ' 词'].join(' · ')),
        h('dt', null, '行程'), h('dd', null, S.config.tripStart ? S.config.tripStart + ' 至 ' + (S.config.tripEnd || '') : '–'),
        h('dt', null, '阈值'), h('dd', { class: 'mono' }, '停顿 ≥ ' + S.config.pauseSec + 's · 长停顿 ≥ ' + S.config.longPauseSec + 's · 低置信 < ' + S.config.lowConf + ' · 最长 ' + S.config.maxRecSec + 's')),
      url ? h('div', { class: 'copy-line' }, code, h('button', { class: 'btn small ghost', type: 'button', onclick: () => copyText(url, code) }, '复制地址')) : null,
      h('p', { class: 'small muted' }, '录音分析脚本和流程随页面发布在 tools/analyze.py 和 tools/RUNBOOK.md。'));
  }

  return { init, show, hide };
})();
