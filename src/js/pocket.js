/* =====================================================================
 * 口袋本：最佳回答（可编辑）、词汇缺口、听力清单、前三类错误和口诀；导出离线 HTML
 * ===================================================================== */

const Pocket = (() => {
  let root = null, visible = false, editing = null;

  function init(el) {
    root = el;
    ['bank', 'vocab', 'nodes', 'turns', 'sessions', 'recordings', 'audio'].forEach(k => Bus.on(k, () => { if (visible && !editing) render(); }));
  }
  function show() { visible = true; render(); }
  function hide() { visible = false; }

  function myTop() {
    const all = Data.answerUnits().sort((a, b) => String(a.at).localeCompare(String(b.at))).flatMap(u => u.errors);
    const top = Data.tallyErrors(all).slice(0, 3);
    const last = S.sessions.find(s => s.endedAt && s.summary && s.summary.rule_zh);
    return { top, rule: last ? last.summary.rule_zh : '', focus: last ? arr(last.summary.next_focus_zh) : [] };
  }

  function render() {
    if (!root) return;
    if (!Platform.store.available) { put(clear(root), h('div', { class: 'notice bad' }, '没有连上数据库。')); return; }
    const practiced = S.nodes.filter(n => n.track !== 'listening');
    const withBank = practiced.filter(n => S.bank[n.id]);
    const without = practiced.filter(n => !S.bank[n.id]);
    const mt = myTop();
    put(clear(root),
      h('div', { class: 'row-between' },
        h('h2', { class: 'section-title' }, '口袋本'),
        Platform.blobs.canSave ? h('button', { class: 'btn', type: 'button', onclick: exportPocket }, '导出离线版') : h('span', { class: 'small muted' }, '这个视图不能导出文件')),
      h('p', { class: 'small muted' }, '导出的是一个 HTML 文件，存在手机里，没网也能打开。出发前（10/16）记得导出一次最新的。'),
      Data.audioMissing() ? Record.taskBanner() : null,

      h('section', { class: 'card stack' },
        h('h3', { class: 'section-title' }, '我的前三类错误'),
        mt.top.length ? h('div', { class: 'top-errs' }, mt.top.map((x, i) => h('div', { class: 'top-err' },
          h('span', { class: 'rank' }, String(i + 1)),
          h('div', null, h('span', { class: 't' }, ERROR_MAP[x.type] ? ERROR_MAP[x.type].name : x.type), h('span', { class: 'small muted' }, ' ×' + x.count)),
          h('span'),
          h('p', { class: 'ex' }, x.example_orig ? h('s', null, x.example_orig) : null, x.example_orig ? ' → ' : '', x.example_fix),
          x.note_zh ? h('p', { class: 'small', style: 'grid-column:2 / span 2' }, x.note_zh) : null))) : h('p', { class: 'muted' }, '还没有错误记录。'),
        mt.rule ? h('p', { class: 'notice info' }, h('b', null, '口诀：'), mt.rule) : null,
        mt.focus.length ? h('p', { class: 'small' }, '下次重点：' + mt.focus.join('；')) : null),

      h('section', { class: 'card stack' },
        h('h3', { class: 'section-title' }, '最佳回答 ', h('span', { class: 'muted' }, withBank.length + '/' + practiced.length)),
        withBank.length ? withBank.map(bankItem) : h('p', { class: 'muted' }, '还没有。在练习页练完一个节点，点"这个节点练完了"，最佳回答会存到这里。'),
        without.length ? h('p', { class: 'small muted' }, '还没整理：' + without.map(n => n.id + ' ' + n.title_zh).join('、')) : null),

      h('section', { class: 'card stack' },
        h('h3', { class: 'section-title' }, '词汇缺口 ', h('span', { class: 'muted' }, S.vocab.length + ' 个')),
        S.vocab.length ? h('div', { class: 'phrase-list' }, S.vocab.map(vocabRow)) : h('p', { class: 'muted' }, '作答时卡住直接说中文，Claude 会把这些词记到这里。')),

      h('section', { class: 'card stack' },
        h('h3', { class: 'section-title' }, '听力清单'),
        TRACKS.map(tr => {
          const ns = S.nodes.filter(n => n.track === tr.id && arr(n.listen).length);
          if (!ns.length) return null;
          return h('details', { class: 'listen' }, h('summary', null, tr.name + ' · ' + ns.reduce((a, n) => a + n.listen.length, 0) + ' 条'),
            h('div', { class: 'listen-body' }, ns.map(n => h('div', { class: 'stack-s' },
              h('p', { class: 'label' }, n.id + ' ' + n.title_zh),
              h('div', { class: 'phrase-list' }, n.listen.map(l => h('div', { class: 'phrase' },
                h('p', { class: 'en-s' }, l.en),
                h('p', { class: 'zh' }, l.zh || '', l.note ? h('span', { class: 'note' }, ' · ' + l.note) : null),
                l.tts === false ? h('span') : sayBtn(l.en))))))));
        })));
  }

  function bankItem(n) {
    const b = S.bank[n.id];
    const box = h('div', { class: 'bank-item' });
    const view = () => put(clear(box),
      h('div', { class: 'row-between' }, h('b', null, n.id + ' ' + n.title_zh), h('span', { class: 'small muted' }, b.edited ? '已手动修改' : '')),
      n.main_q ? h('p', { class: 'small muted en-s' }, n.main_q) : null,
      h('div', { class: 'row', style: 'align-items:flex-start;flex-wrap:nowrap' }, h('p', { class: 'en', style: 'flex:1' }, b.best_en), sayBtn(b.best_en)),
      arr(b.chunks).length ? h('div', { class: 'chunks' }, b.chunks.map(c => h('div', { class: 'chunk' }, h('span', { class: 'en-s' }, c.en), h('span', { class: 'zh' }, c.zh || ''), sayBtn(c.en)))) : null,
      h('div', null, h('button', { class: 'btn quiet small', type: 'button', onclick: edit }, '修改')));
    const edit = () => {
      editing = n.id;
      const ta = h('textarea', { class: 'en', id: 'bank-edit-' + n.id, rows: 4 });
      ta.value = b.best_en;
      put(clear(box), h('b', null, n.id + ' ' + n.title_zh), ta,
        h('div', { class: 'row' },
          h('button', { class: 'btn small', type: 'button', onclick: async () => {
            const v = ta.value.trim();
            if (!v) return;
            try { await Platform.store.update('bank/' + n.id, { best_en: v, edited: true, updatedAt: nowIso() }); toast('已保存'); }
            catch (e) { toast('没存上：' + (e.code || e)); return; }
            editing = null; render();
          } }, '保存'),
          h('button', { class: 'btn quiet small', type: 'button', onclick: () => { editing = null; render(); } }, '取消')));
      ta.focus();
    };
    view();
    return box;
  }

  function vocabRow(v) {
    return h('div', { class: 'phrase' },
      h('p', { class: 'en-s' }, v.en, h('span', { class: 'muted' }, '  ' + v.zh)),
      h('p', { class: 'zh' }, v.example || '', ' ',
        h('button', { class: 'link-btn', type: 'button', onclick: () => Platform.store.remove('vocab/' + v.id).then(() => toast('已删除'), e => toast('删除失败：' + (e.code || e))) }, '删除')),
      sayBtn(v.example || v.en));
  }

  /* ---------------- 导出离线 HTML ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const say = t => '<button class="say" data-t="' + esc(t) + '" aria-label="朗读">▶</button>';

  function buildHtml() {
    const mt = myTop();
    const parts = [];
    parts.push('<h1>口语口袋本</h1><p class="m">导出于 ' + esc(localDate()) + ' · ' + esc(S.config.tripStart ? '入境 ' + S.config.tripStart : '') + '</p>');
    parts.push('<h2>我的前三类错误</h2>');
    if (mt.top.length) {
      parts.push('<ol>' + mt.top.map(x => '<li><b>' + esc(ERROR_MAP[x.type] ? ERROR_MAP[x.type].name : x.type) + '</b> ×' + x.count +
        '<div class="en"><s>' + esc(x.example_orig) + '</s> → ' + esc(x.example_fix) + '</div>' + (x.note_zh ? '<div class="m">' + esc(x.note_zh) + '</div>' : '') + '</li>').join('') + '</ol>');
    } else parts.push('<p class="m">还没有记录。</p>');
    if (mt.rule) parts.push('<p class="rule"><b>口诀：</b>' + esc(mt.rule) + '</p>');

    parts.push('<h2>最佳回答</h2>');
    const nodes = S.nodes.filter(n => n.track !== 'listening');
    for (const n of nodes) {
      const b = S.bank[n.id];
      if (!b) continue;
      parts.push('<section><h3>' + esc(n.id + ' ' + n.title_zh) + '</h3>' + (n.main_q ? '<p class="q">' + esc(n.main_q) + ' ' + say(n.main_q) + '</p>' : '') +
        '<p class="en best">' + esc(b.best_en) + ' ' + say(b.best_en) + '</p>' +
        (arr(b.chunks).length ? '<ul class="chunks">' + b.chunks.map(c => '<li><span class="en">' + esc(c.en) + '</span> ' + say(c.en) + '<br><span class="m">' + esc(c.zh) + '</span></li>').join('') + '</ul>' : '') + '</section>');
    }
    const svc = S.nodes.filter(n => arr(n.say).length);
    if (svc.length) {
      parts.push('<h2>办事时要说的话</h2>');
      for (const n of svc) parts.push('<section><h3>' + esc(n.id + ' ' + n.title_zh) + '</h3><ul>' + n.say.map(s => '<li class="en">' + esc(s) + ' ' + say(s) + '</li>').join('') + '</ul></section>');
    }
    if (S.vocab.length) {
      parts.push('<h2>词汇缺口</h2><ul>' + S.vocab.map(v => '<li><span class="en">' + esc(v.en) + '</span> ' + say(v.en) + ' <span class="m">' + esc(v.zh) + '</span>' + (v.example ? '<div class="en m">' + esc(v.example) + '</div>' : '') + '</li>').join('') + '</ul>');
    }
    parts.push('<h2>听力清单</h2>');
    for (const n of S.nodes.filter(n => arr(n.listen).length)) {
      parts.push('<section><h3>' + esc(n.id + ' ' + n.title_zh) + '</h3><ul>' + n.listen.map(l => '<li><span class="en">' + esc(l.en) + '</span>' + (l.tts === false ? '' : ' ' + say(l.en)) + '<br><span class="m">' + esc(l.zh) + (l.note ? ' · ' + esc(l.note) : '') + '</span></li>').join('') + '</ul></section>');
    }
    const css = ':root{color-scheme:light dark;--bg:#F1F3F7;--ink:#14203A;--m:#56627A;--line:#D4DAE4;--acc:#1E4D8C;--hi:#B0382A;--card:#fff}' +
      '@media (prefers-color-scheme:dark){:root{--bg:#0E1420;--ink:#E6EAF2;--m:#A8B3C7;--line:#2B3751;--acc:#8FB3EC;--hi:#F2978B;--card:#161F31}}' +
      'body{margin:0;padding:16px;background:var(--bg);color:var(--ink);font:15px/1.6 system-ui,-apple-system,"HarmonyOS Sans SC","PingFang SC","Noto Sans SC",sans-serif}' +
      'main{max-width:680px;margin:0 auto}h1{font-size:22px;margin:0}h2{font-size:17px;margin:28px 0 8px;padding-top:12px;border-top:2px solid var(--acc)}h3{font-size:15px;margin:14px 0 4px}' +
      'section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin:8px 0}' +
      '.en{font-family:Georgia,"Noto Serif",serif;font-size:17px}.best{font-size:18px}.q{color:var(--m);font-family:Georgia,serif}.m{color:var(--m);font-size:14px}' +
      's{color:var(--hi)}ul,ol{padding-left:20px;margin:6px 0}li{margin:6px 0}.rule{background:var(--card);border-left:4px solid #F0B40A;padding:8px 12px;border-radius:6px}' +
      '.say{border:1px solid var(--line);background:var(--card);color:var(--acc);border-radius:50%;width:28px;height:28px;font-size:11px;cursor:pointer;vertical-align:middle}.no-tts .say{display:none}';
    const js = '(function(){var s=window.speechSynthesis;function v(){var a=s?s.getVoices():[];return a.filter(function(x){return /^en/i.test(x.lang)})[0]||null}' +
      'if(!s){document.documentElement.className="no-tts";return}document.addEventListener("click",function(e){var b=e.target.closest(".say");if(!b)return;s.cancel();var u=new SpeechSynthesisUtterance(b.getAttribute("data-t"));var x=v();if(x){u.voice=x;u.lang=x.lang}else u.lang="en-US";u.rate=0.95;s.speak(u)})})();';
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>口语口袋本</title><style>' + css + '</style></head><body><main>' + parts.join('\n') + '</main><script>' + js + '<\/script></body></html>';
  }

  async function exportPocket() {
    try {
      const r = await Platform.blobs.saveFile('口语口袋本-' + localDate() + '.html', buildHtml());
      toast(r && r.status === 'delivered' ? '已交出' : '已保存');
    } catch (e) {
      toast(e.code === 'declined' ? '已取消' : e.code === 'rate_limited' ? '已经有一个保存框开着了' : '导出失败：' + (e.code || e));
    }
  }

  return { init, show, hide };
})();
