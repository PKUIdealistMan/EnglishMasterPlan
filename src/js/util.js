/* ===================== 通用小工具 ===================== */

const $ = (sel, root = document) => root.querySelector(sel);

/* 建元素。字符串一律作为文本插入，数据库和 Claude 返回的内容不会被当成 HTML。 */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  setAttrs(el, attrs);
  appendKids(el, kids);
  return el;
}
function setAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'hidden' || k === 'disabled' || k === 'checked' || k === 'value' || k === 'open') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}
function appendKids(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
function svgEl(tag, attrs, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  appendKids(el, kids);
  return el;
}
function clear(el) { while (el && el.firstChild) el.removeChild(el.firstChild); return el; }
/* 追加子节点；和原生 append 不同，null/false 会被跳过，数组会被展开 */
function put(el, ...kids) { appendKids(el, kids); return el; }

const ICON_PATHS = {
  talk: 'M4 5h16v10H9l-5 4z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  book: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3zM5 17a3 3 0 0 1 3-3h11',
};
function icon(name) {
  return svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svgEl('path', { d: ICON_PATHS[name] }));
}

/* localStorage：读写都包 try/catch，失败时页面照常工作 */
const ls = {
  get(key, dflt = null) {
    try { const v = localStorage.getItem('kx:' + key); return v == null ? dflt : JSON.parse(v); } catch (_) { return dflt; }
  },
  set(key, val) { try { localStorage.setItem('kx:' + key, JSON.stringify(val)); } catch (_) {} },
  del(key) { try { localStorage.removeItem('kx:' + key); } catch (_) {} },
};

function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}
function uid(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}
const nowIso = () => new Date().toISOString();
function localDate(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function countWords(s) { return ((s || '').match(/[A-Za-z]+(?:['’][A-Za-z]+)*/g) || []).length; }
const str = v => (typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim());
const arr = v => (Array.isArray(v) ? v : []);
function fmtBytes(n) {
  if (n == null) return '–';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  const s = Math.round(sec);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function daysUntil(ymd) {
  if (!ymd) return null;
  const [y, m, d] = ymd.split('-').map(Number);
  const target = new Date(y, m - 1, d);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

let toastTimer = null;
function toast(msg, ms = 2600) {
  let el = $('#toast');
  if (!el) { el = h('div', { id: 'toast', class: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* 底部弹出层。返回关闭函数。 */
function openSheet(build) {
  const back = h('div', { class: 'sheet-back' });
  const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' });
  const close = () => back.remove();
  back.addEventListener('click', e => { if (e.target === back) close(); });
  back.append(sheet);
  document.body.append(back);
  build(sheet, close);
  return close;
}

async function copyText(text, fallbackEl) {
  try { await navigator.clipboard.writeText(text); toast('已复制'); return true; } catch (_) {
    if (fallbackEl) {
      const r = document.createRange(); r.selectNodeContents(fallbackEl);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
      toast('复制不了，已选中文字，请长按复制');
    }
    return false;
  }
}

/* ---------- 朗读：speechSynthesis 的英文语音；没有就隐藏朗读按钮 ---------- */
const TTS = (() => {
  let voices = [], voice = null, checked = false;
  const subs = [];
  const synth = window.speechSynthesis;
  function load() {
    if (!synth) return;
    const all = synth.getVoices() || [];
    voices = all.filter(v => /^en([-_]|$)/i.test(v.lang));
    const want = ls.get('ttsVoice');
    voice = voices.find(v => v.voiceURI === want) || voices.find(v => /en[-_]US/i.test(v.lang)) || voices.find(v => /en[-_]GB/i.test(v.lang)) || voices[0] || null;
    if (voices.length) { checked = true; notify(); }
  }
  function notify() {
    document.documentElement.classList.toggle('no-tts', !voice);
    subs.forEach(f => f());
  }
  if (synth) {
    load();
    try { synth.addEventListener('voiceschanged', load); } catch (_) { synth.onvoiceschanged = load; }
    setTimeout(() => { if (!checked) { load(); checked = true; notify(); } }, 3000);
  } else {
    checked = true;
  }
  document.documentElement.classList.toggle('no-tts', !voice);
  return {
    get available() { return !!voice; },
    get voices() { return voices; },
    get voice() { return voice; },
    setVoice(uri) { ls.set('ttsVoice', uri); load(); notify(); },
    speak(text, rate) {
      if (!voice || !text) return;
      synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.voice = voice; u.lang = voice.lang;
      u.rate = rate || ls.get('ttsRate', 0.95);
      synth.speak(u);
    },
    onChange(f) { subs.push(f); },
  };
})();

function sayBtn(text) {
  return h('button', {
    class: 'say-btn', type: 'button', 'aria-label': '朗读', title: '朗读',
    onclick: e => { e.stopPropagation(); TTS.speak(typeof text === 'function' ? text() : text); },
  }, svgEl('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svgEl('path', { d: 'M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round' })));
}

/* 简单事件总线：数据更新时通知各个视图 */
const Bus = (() => {
  const m = {};
  return {
    on(evt, fn) { (m[evt] = m[evt] || []).push(fn); },
    emit(evt, arg) { (m[evt] || []).forEach(fn => { try { fn(arg); } catch (e) { console.error(e); } }); },
  };
})();
