/* =====================================================================
 * 入口：底部导航、顶栏（倒计时、本次练习）、结束本次练习的小结
 * ===================================================================== */

const App = (() => {
  const TABS = [
    { id: 'practice', label: '练习', icon: 'talk' },
    { id: 'record', label: '录音', icon: 'mic' },
    { id: 'dash', label: '看板', icon: 'chart' },
    { id: 'pocket', label: '口袋本', icon: 'book' },
  ];
  const MODS = { practice: Practice, record: Record, dash: Dash, pocket: Pocket, settings: Settings };
  const tabBtns = {};
  let current = null, prev = 'practice';

  function buildTabs() {
    const bar = $('#tabs');
    for (const t of TABS) {
      const badge = h('span', { class: 'badge', hidden: true });
      const b = h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': 'false', onclick: () => go(t.id) }, icon(t.icon), h('span', null, t.label), badge);
      b._badge = badge;
      tabBtns[t.id] = b;
      put(bar, b);
    }
  }

  function go(id, anchor) {
    if (!MODS[id]) id = 'practice';
    if (current && current !== id) {
      MODS[current].hide && MODS[current].hide();
      if (current !== 'settings') prev = current;
    }
    for (const k of Object.keys(MODS)) $('#view-' + k).hidden = k !== id;
    for (const [k, b] of Object.entries(tabBtns)) b.setAttribute('aria-selected', String(k === id));
    const changed = current !== id;
    current = id;
    if (id !== 'settings') ls.set('tab', id);
    MODS[id].show(anchor);
    if (changed && id !== 'practice' && id !== 'settings') window.scrollTo(0, 0);
  }
  function back() { go(prev || 'practice'); }

  function renderCountdown() {
    const el = $('#countdown');
    const d = daysUntil(S.config.tripStart), e = daysUntil(S.config.tripEnd);
    if (d == null) el.textContent = '';
    else if (d > 0) el.textContent = '距入境申根 ' + d + ' 天';
    else if (e != null && e >= 0) el.textContent = '旅途第 ' + (1 - d) + ' 天';
    else el.textContent = '';
  }

  function renderSession() {
    const pill = $('#session-pill');
    const id = Sessions.currentId;
    if (!id) { pill.hidden = true; return; }
    pill.hidden = false;
    put(clear(pill), '本次 ', h('b', null, String(Data.sessionTurns(id).length)), ' 条 · 结束');
  }

  function renderBadge() {
    const b = tabBtns.record && tabBtns.record._badge;
    if (!b) return;
    const n = S.recordings.filter(r => r.status === 'pending').length;
    b.hidden = !n;
    b.textContent = String(n);
  }

  function endSession() {
    const id = Sessions.currentId;
    if (!id) return;
    const n = Data.sessionTurns(id).length;
    openSheet((sheet, close) => {
      const body = h('div', { class: 'stack' });
      const confirm = () => {
        put(clear(body), h('p', { class: 'status row' }, h('span', { class: 'spin', 'aria-hidden': 'true' }), ' 正在统计、生成口诀…… Thinking…'));
        Sessions.end().then(
          res => showSummary(body, res, close),
          e => put(clear(body), h('div', { class: 'notice bad' }, '没能结束：' + ((e && e.code) || e)), h('button', { class: 'btn ghost', type: 'button', onclick: close }, '关闭')));
      };
      put(sheet, h('h2', { class: 'section-title' }, '结束本次练习'), body);
      put(body,
        h('p', null, '本次练习（' + id + '）共 ' + n + ' 条回答。结束后生成小结：前三类错误、次数、例句和一句口诀。'),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: confirm }, '结束并生成小结'),
          h('button', { class: 'btn ghost', type: 'button', onclick: close }, '继续练')));
    });
  }

  function showSummary(body, res, close) {
    const s = res.summary;
    put(clear(body),
      s.top.length ? h('div', { class: 'top-errs' }, s.top.map((t, i) => h('div', { class: 'top-err' },
        h('span', { class: 'rank' }, String(i + 1)),
        h('div', null, h('span', { class: 't' }, ERROR_MAP[t.type] ? ERROR_MAP[t.type].name : t.type), h('span', { class: 'small muted' }, ' ×' + t.count)),
        h('span'),
        h('p', { class: 'ex' }, t.example_orig ? h('s', null, t.example_orig) : null, t.example_orig ? ' → ' : '', t.example_fix))))
        : h('p', null, s.nTurns ? '这次没有发现错误。' : '这次没有作答，已结束。'),
      s.rule_zh ? h('p', { class: 'notice info' }, h('b', null, '口诀：'), s.rule_zh) : null,
      arr(s.next_focus_zh).length ? h('p', null, '下次重点：' + s.next_focus_zh.join('；')) : null,
      res.llmError ? h('p', { class: 'small muted' }, '口诀没生成：' + sampleErrZh(res.llmError.code)) : null,
      h('button', { class: 'btn block', type: 'button', onclick: close }, '好'));
  }

  async function start() {
    buildTabs();
    $('#settings-btn').addEventListener('click', () => go('settings'));
    $('#session-pill').addEventListener('click', endSession);
    Practice.init($('#view-practice'));
    Record.init($('#view-record'));
    Dash.init($('#view-dash'));
    Pocket.init($('#view-pocket'));
    Settings.init($('#view-settings'));
    Bus.on('config', renderCountdown);
    Bus.on('session', renderSession);
    Bus.on('recordings', renderBadge);
    put(clear($('#view-practice')), h('p', { class: 'muted' }, '正在连接 Claude 查看器……'));
    await Platform.ready;
    Data.start();
    const hash = (location.hash || '').slice(1);
    const initial = hash === 'probe' ? 'settings' : MODS[hash] ? hash : ls.get('tab', 'practice');
    go(initial, hash === 'probe' ? 'probe' : undefined);
  }

  return { start, go, back, endSession };
})();

App.start();
