/* =====================================================================
 * 看板：前三类错误（每百词、近 7 天对比之前）、全部类型、反问率、流利度趋势
 * ===================================================================== */

const Dash = (() => {
  let root = null, visible = false, usage = null, usageErr = null, usageAt = 0;

  function init(el) {
    root = el;
    ['turns', 'recordings', 'sessions', 'vocab'].forEach(k => Bus.on(k, () => { if (visible) render(); }));
  }
  function show() {
    visible = true;
    render();
    if (Platform.blobs.available && Date.now() - usageAt > 60000) {
      usageAt = Date.now();
      Platform.blobs.usage().then(u => { usage = u; usageErr = null; if (visible) render(); }, e => { usageErr = e; if (visible) render(); });
    }
  }
  function hide() { visible = false; }

  function ratesOf(units) {
    const words = units.reduce((a, u) => a + (u.words || 0), 0);
    const list = Data.tallyErrors(units.flatMap(u => u.errors));
    return { words, list, byType: Object.fromEntries(list.map(x => [x.type, x])) };
  }
  const per100 = (x, words) => (x && words ? (x.count / words) * 100 : 0);
  const f1 = v => (v == null ? '–' : (Math.round(v * 10) / 10).toFixed(1));

  function render() {
    if (!root) return;
    if (!Platform.store.available) { put(clear(root), h('div', { class: 'notice bad' }, '没有连上数据库。')); return; }
    const units = Data.answerUnits().sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const cutoff = Date.now() - 7 * 86400000;
    const recent = units.filter(u => new Date(u.at).getTime() >= cutoff);
    const before = units.filter(u => new Date(u.at).getTime() < cutoff);
    const A = ratesOf(units), R = ratesOf(recent), B = ratesOf(before);

    put(clear(root),
      h('div', { class: 'kpis' },
        kpi(S.turns.length, '条回答'),
        kpi(S.sessions.filter(s => s.endedAt).length, '次练习'),
        kpi(S.recordings.length, '段录音')),
      topErrors(A, R, B),
      askBack(),
      fluency(),
      allTypes(A),
      lastSessions(),
      footer());
  }

  function kpi(v, k) { return h('div', { class: 'kpi' }, h('span', { class: 'v' }, String(v)), h('span', { class: 'k' }, k)); }
  function card(title, sub, ...kids) {
    return h('section', { class: 'card stack' }, h('div', { class: 'row-between' }, h('h2', { class: 'section-title' }, title), sub ? h('span', { class: 'small muted' }, sub) : null), ...kids);
  }

  function topErrors(A, R, B) {
    if (!A.list.length) return card('前三类错误', null, h('p', { class: 'muted' }, '还没有错误记录。练完几句，这里就有数了。'));
    const base = R.words ? R : A;
    const ranked = base.list.slice().sort((a, b) => per100(b, base.words) - per100(a, base.words) || b.high - a.high).slice(0, 3);
    return card('前三类错误', R.words ? '按每百词次数，近 7 天' : '按每百词次数，全部',
      h('div', { class: 'top-errs' }, ranked.map((x, i) => {
        const t = ERROR_MAP[x.type];
        const rr = R.words ? per100(R.byType[x.type], R.words) : null;
        const rb = B.words ? per100(B.byType[x.type], B.words) : null;
        const ex = A.byType[x.type] || x;
        let trend = null;
        if (rr != null && rb != null) {
          const d = rr - rb;
          trend = Math.abs(d) < 0.05 ? h('span', null, '持平') : d > 0 ? h('span', { class: 'trend-up' }, '↑ 变多') : h('span', { class: 'trend-down' }, '↓ 变少');
        }
        return h('div', { class: 'top-err' },
          h('span', { class: 'rank' }, String(i + 1)),
          h('div', null, h('span', { class: 't' }, t ? t.name : x.type), ' ', h('span', { class: 'mono small muted' }, x.type)),
          h('div', { class: 'rate' },
            h('div', null, h('b', { class: 'mono' }, f1(rr != null ? rr : per100(A.byType[x.type], A.words))), ' / 百词'),
            rb != null ? h('div', null, '之前 ', h('span', { class: 'mono' }, f1(rb)), ' ', trend) : null),
          ex.example_orig || ex.example_fix ? h('p', { class: 'ex' }, ex.example_orig ? h('s', null, ex.example_orig) : null, ex.example_orig ? ' → ' : '', ex.example_fix) : null);
      })));
  }

  function askBack() {
    const social = S.turns.filter(t => { const n = S.nodeMap[t.nodeId]; return n && n.track === 'social'; }).slice(-20);
    if (!social.length) return card('反问率', null, h('p', { class: 'muted' }, '社交场景还没有作答。'));
    const yes = social.filter(t => t.asked_back).length;
    const pct = Math.round((yes / social.length) * 100);
    return card('反问率', '社交场景最近 ' + social.length + ' 条',
      h('div', { class: 'row-between' }, h('span', { class: 'kpi-v', style: 'font-size:28px;font-weight:700' }, pct + '%'), h('span', { class: 'small muted' }, yes + ' 条以提问结尾')),
      h('div', { class: 'meter-bar', role: 'img', 'aria-label': '反问率 ' + pct + '%' }, h('span', { style: 'width:' + pct + '%' })),
      pct < 50 ? h('p', { class: 'small' }, '答完别停：加一句 ', h('span', { class: 'en-s' }, 'What about you?'), ' 就能把话题接下去。') : null);
  }

  /* 固定题"一分钟自我介绍"的趋势：单序列迷你折线，悬停看每个点 */
  function fluency() {
    const recs = S.recordings.filter(r => r.fixedPrompt === 'intro' && r.status === 'analyzed' && r.analysis)
      .slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    if (!recs.length) return card('流利度趋势', '一分钟自我介绍', h('p', { class: 'muted' }, '在"录音"里选"一分钟自我介绍"录几次，分析后这里显示语速、停顿和连续词数的变化。'));
    const metrics = [
      { key: 'wpm', name: '语速', unit: '词/分', better: 'up' },
      { key: 'pauses_per_min', name: '每分钟停顿', unit: '次', better: 'down' },
      { key: 'mean_length_of_run', name: '平均连续词数', unit: '词', better: 'up' },
    ];
    return card('流利度趋势', '一分钟自我介绍 · ' + recs.length + ' 次',
      h('div', { class: 'spark-grid' }, metrics.map(m => {
        const pts = recs.map(r => ({ v: Number(r.analysis[m.key]), at: r.createdAt })).filter(p => isFinite(p.v));
        if (!pts.length) return null;
        const last = pts[pts.length - 1].v, first = pts[0].v;
        let delta = null;
        if (pts.length > 1) {
          const d = last - first;
          const good = m.better === 'up' ? d > 0 : d < 0;
          delta = h('span', { class: 'small ' + (Math.abs(d) < 0.05 ? 'muted' : good ? 'trend-down' : 'trend-up') }, (d > 0 ? '+' : '') + f1(d) + (Math.abs(d) < 0.05 ? '' : good ? ' 更好' : ' 变差'));
        }
        return h('div', { class: 'spark' },
          h('span', { class: 'k' }, m.name + '（' + m.unit + '）'),
          h('div', { class: 'row' }, h('span', { class: 'v mono' }, f1(last)), delta),
          pts.length > 1 ? sparkline(pts, m) : h('span', { class: 'small muted' }, '录满 2 次后显示趋势'));
      })));
  }

  function sparkline(pts, m) {
    const W = 220, H = 52, px = 5, py = 6;
    const vs = pts.map(p => p.v);
    let min = Math.min(...vs), max = Math.max(...vs);
    if (max - min < 1e-6) { min -= 1; max += 1; }
    const x = i => px + (i * (W - 2 * px)) / (pts.length - 1);
    const y = v => H - py - ((v - min) / (max - min)) * (H - 2 * py);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
    const area = line + ' L' + x(pts.length - 1).toFixed(1) + ' ' + (H - py) + ' L' + x(0).toFixed(1) + ' ' + (H - py) + ' Z';
    const tip = h('span', { class: 'tip', hidden: true });
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'xMidYMid meet', role: 'img', 'aria-label': m.name + '：' + pts.map(p => f1(p.v)).join('，') },
      svgEl('line', { class: 'sp-grid', x1: px, x2: W - px, y1: H - py, y2: H - py }),
      svgEl('path', { class: 'sp-area', d: area }),
      svgEl('path', { class: 'sp-line', d: line }),
      svgEl('circle', { class: 'sp-dot', cx: x(pts.length - 1), cy: y(pts[pts.length - 1].v), r: 4 }));
    const hover = svgEl('circle', { class: 'sp-hover', r: 4, cx: 0, cy: 0, visibility: 'hidden' });
    svg.append(hover);
    const step = (W - 2 * px) / (pts.length - 1);
    pts.forEach((p, i) => {
      const hit = svgEl('rect', { class: 'sp-hit', x: x(i) - step / 2, y: 0, width: step, height: H });
      const on = () => { hover.setAttribute('cx', x(i)); hover.setAttribute('cy', y(p.v)); hover.setAttribute('visibility', 'visible'); tip.textContent = fmtWhen(p.at) + ' · ' + f1(p.v); tip.hidden = false; };
      hit.addEventListener('pointerenter', on);
      hit.addEventListener('pointerdown', on);
      hit.addEventListener('pointerleave', () => { tip.hidden = true; hover.setAttribute('visibility', 'hidden'); });
      svg.append(hit);
    });
    return h('div', { style: 'position:relative' }, svg, tip);
  }

  function allTypes(A) {
    const rows = ERROR_TYPES.map(t => ({ t, x: A.byType[t.code] || { count: 0, high: 0 } }))
      .sort((a, b) => b.x.count - a.x.count);
    return card('全部错误类型', A.words ? '共 ' + A.words + ' 词' : null,
      h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl' },
        h('thead', null, h('tr', null, h('th', null, '类型'), h('th', null, '代码'), h('th', { class: 'num' }, '次数'), h('th', { class: 'num' }, 'high 占比'))),
        h('tbody', null, rows.map(({ t, x }) => h('tr', { class: x.count ? '' : 'zero' },
          h('td', null, t.name), h('td', { class: 'mono' }, t.code), h('td', { class: 'num mono' }, String(x.count)),
          h('td', { class: 'num mono' }, x.count ? Math.round((x.high / x.count) * 100) + '%' : '–')))))));
  }

  function lastSessions() {
    const done = S.sessions.filter(s => s.endedAt && s.summary).slice(0, 3);
    if (!done.length) return null;
    return card('最近的练习小结', null, h('div', { class: 'stack' }, done.map(s => h('div', { class: 'stack-s' },
      h('p', { class: 'small muted' }, s.id + ' · ' + (s.summary.nTurns || 0) + ' 条回答'),
      arr(s.summary.top).length ? h('p', null, s.summary.top.map(t => (ERROR_MAP[t.type] ? ERROR_MAP[t.type].name : t.type) + ' ×' + t.count).join('，')) : h('p', { class: 'muted' }, '没有发现错误'),
      s.summary.rule_zh ? h('p', { class: 'notice info' }, h('b', null, '口诀：'), s.summary.rule_zh) : null))));
  }

  function footer() {
    const u = usage;
    return card('其他', null,
      h('div', { class: 'row-between' }, h('span', null, '词汇缺口'), h('button', { class: 'link-btn', type: 'button', onclick: () => App.go('pocket') }, S.vocab.length + ' 个 · 去口袋本')),
      Platform.blobs.available ? h('div', { class: 'stack-s' },
        h('div', { class: 'row-between' }, h('span', null, '录音存储'),
          h('span', { class: 'small mono' }, u ? fmtBytes(u.bytes) + ' / ' + fmtBytes(u.maxBytes) + ' · ' + u.files + ' / ' + u.maxFiles + ' 个文件' : usageErr ? '读取失败' : '读取中……')),
        u ? h('div', { class: 'meter-bar' }, h('span', { style: 'width:' + Math.min(100, Math.round((u.bytes / Math.max(1, u.maxBytes)) * 100)) + '%' })) : null) : null);
  }

  return { init, show, hide };
})();
