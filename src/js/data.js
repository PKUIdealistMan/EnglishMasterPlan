/* =====================================================================
 * 数据：订阅 db，维护内存里的状态 S。统计一律由 turns 和 recordings 实时算出。
 * ===================================================================== */

const DEFAULT_CONFIG = { pauseSec: 0.5, longPauseSec: 1.0, lowConf: 0.6, maxRecSec: 180, artifactUrl: '' };

const S = {
  nodes: [], nodeMap: {},
  turns: [],          // 按时间正序
  recordings: [],     // 按时间倒序
  sessions: [],       // 按开始时间倒序
  bank: {}, vocab: [], personas: [],
  profile: null, profileDraft: null,
  config: Object.assign({}, DEFAULT_CONFIG),
  loaded: {},
  dbError: null,
};

const Data = (() => {
  const TRACK_ORDER = { social: 0, service: 1, listening: 2 };
  function sortNodes(list) {
    return list.slice().sort((a, b) => (TRACK_ORDER[a.track] ?? 9) - (TRACK_ORDER[b.track] ?? 9) || (a.order || 0) - (b.order || 0) || String(a.id).localeCompare(String(b.id)));
  }
  function onErr(what) {
    return e => {
      S.dbError = e;
      console.warn('db ' + what, e);
      Bus.emit('dbError', e);
    };
  }
  function loaded(key) { S.loaded[key] = true; Bus.emit(key); Bus.emit('any', key); }

  function start() {
    const st = Platform.store;
    if (!st.available) return;
    st.watch('nodes', { limit: 300 }, docs => { S.nodes = sortNodes(docs); S.nodeMap = Object.fromEntries(S.nodes.map(n => [n.id, n])); loaded('nodes'); }, onErr('nodes'));
    st.watch('turns', { orderBy: 'createdAt', dir: 'desc', limit: 1000 }, docs => { S.turns = docs.slice().reverse(); loaded('turns'); }, onErr('turns'));
    st.watch('recordings', { orderBy: 'createdAt', dir: 'desc', limit: 500 }, docs => { S.recordings = docs; loaded('recordings'); }, onErr('recordings'));
    st.watch('sessions', { orderBy: 'startedAt', dir: 'desc', limit: 300 }, docs => { S.sessions = docs; loaded('sessions'); }, onErr('sessions'));
    st.watch('bank', { limit: 300 }, docs => { S.bank = Object.fromEntries(docs.map(d => [d.id, d])); loaded('bank'); }, onErr('bank'));
    st.watch('vocab', { orderBy: 'createdAt', dir: 'desc', limit: 1000 }, docs => { S.vocab = docs; loaded('vocab'); }, onErr('vocab'));
    st.watch('personas', { limit: 100 }, docs => { S.personas = docs.slice().sort((a, b) => (a.order || 0) - (b.order || 0)); loaded('personas'); }, onErr('personas'));
    st.watchDoc('me/profile', d => { S.profile = d; loaded('profile'); }, onErr('profile'));
    st.watchDoc('config/app', d => { S.config = Object.assign({}, DEFAULT_CONFIG, d || {}); loaded('config'); }, onErr('config'));
    st.watchDoc('config/profileDraft', d => { S.profileDraft = d; loaded('profileDraft'); }, onErr('profileDraft'));
  }

  /* ---------- 派生数据 ---------- */
  const profileFacts = () => arr(S.profile && S.profile.facts).map(str).filter(Boolean);
  const turnsOfNode = id => S.turns.filter(t => t.nodeId === id);

  /* 所有带错误的"作答"：文字作答 + 已分析录音 */
  function answerUnits() {
    const out = S.turns.map(t => ({ at: t.createdAt, words: t.n_words || countWords(t.raw), errors: arr(t.errors), kind: 'turn' }));
    for (const r of S.recordings) {
      if (r.status === 'analyzed' && r.analysis) out.push({ at: r.analyzedAt || r.createdAt, words: r.analysis.n_words || 0, errors: arr(r.analysis.errors), kind: 'rec' });
    }
    return out;
  }

  /* 按类型计数，按次数、再按 high 次数排序；每类带最近一条例句 */
  function tallyErrors(errors) {
    const m = {};
    for (const e of errors) {
      const code = ERROR_MAP[e.type] ? e.type : 'STRUCT';
      const x = m[code] || (m[code] = { type: code, count: 0, high: 0, example_orig: '', example_fix: '', note_zh: '' });
      x.count++;
      if (e.sev === 'high') x.high++;
      if (e.orig || e.fix) { x.example_orig = str(e.orig); x.example_fix = str(e.fix); x.note_zh = str(e.note_zh) || x.note_zh; }
    }
    return Object.values(m).sort((a, b) => b.count - a.count || b.high - a.high);
  }

  const sessionTurns = id => S.turns.filter(t => t.sessionId === id);

  return { start, sortNodes, profileFacts, turnsOfNode, answerUnits, tallyErrors, sessionTurns };
})();

/* =====================================================================
 * 练习场次：用户开始作答时创建，点"结束本次练习"时关闭。id = 日期-序号。
 * ===================================================================== */
const Sessions = (() => {
  let currentId = null;
  let creating = null;

  function openSession() { return S.sessions.find(s => !s.endedAt) || null; }
  function sync() {
    if (currentId) {
      const s = S.sessions.find(x => x.id === currentId);
      if (s && s.endedAt) currentId = null;
      return;
    }
    const o = openSession();
    if (o && localDate(new Date(o.startedAt)) === localDate()) currentId = o.id;
  }
  Bus.on('sessions', () => { sync(); Bus.emit('session'); });
  Bus.on('turns', () => Bus.emit('session'));

  async function ensure() {
    sync();
    if (currentId) return currentId;
    if (creating) return creating;
    creating = (async () => {
      const stale = openSession();
      if (stale) {
        const last = Data.sessionTurns(stale.id).slice(-1)[0];
        await Platform.store.update('sessions/' + stale.id, { endedAt: (last && last.createdAt) || stale.startedAt }).catch(() => {});
      }
      const today = localDate();
      const n = S.sessions.filter(s => String(s.id).startsWith(today + '-')).length + 1;
      let id = today + '-' + n;
      if (S.sessions.some(s => s.id === id)) id = today + '-' + n + '-' + Math.random().toString(36).slice(2, 5);
      await Platform.store.set('sessions/' + id, { startedAt: nowIso(), endedAt: null, summary: null });
      currentId = id;
      Bus.emit('session');
      return id;
    })();
    try { return await creating; } finally { creating = null; }
  }

  function formatTop(top) {
    return top.map(t => `${t.type} (${ERROR_MAP[t.type] ? ERROR_MAP[t.type].name : ''}) ×${t.count}: "${t.example_orig}" → "${t.example_fix}"`).join('\n');
  }

  /* 结束：次数页面自己算，口诀和下次重点让 Claude 写（quick 档） */
  async function end() {
    const id = currentId;
    if (!id) return null;
    const turns = Data.sessionTurns(id);
    const errors = turns.flatMap(t => arr(t.errors));
    const top = Data.tallyErrors(errors).slice(0, 3).map(({ type, count, example_orig, example_fix }) => ({ type, count, example_orig, example_fix }));
    const summary = { top, rule_zh: null, next_focus_zh: [], nTurns: turns.length, nWords: turns.reduce((a, t) => a + (t.n_words || 0), 0) };
    let llmError = null;
    if (top.length && Platform.llm.available) {
      try {
        const r = await Platform.llm.json(fill(PROMPTS.summary, { top3: formatTop(top) }), { tier: 'quick', cache: false });
        summary.rule_zh = str(r && r.rule_zh) || null;
        summary.next_focus_zh = arr(r && r.next_focus_zh).map(str).filter(Boolean).slice(0, 2);
      } catch (e) { llmError = e; }
    }
    await Platform.store.update('sessions/' + id, { endedAt: nowIso(), summary });
    currentId = null;
    Bus.emit('session');
    return { id, summary, llmError };
  }

  return {
    get currentId() { sync(); return currentId; },
    ensure, end, formatTop,
  };
})();
