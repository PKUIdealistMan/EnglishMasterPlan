/* =====================================================================
 * 适配层。所有 claude.use() 调用都在这里；业务代码只用 store / blobs / llm。
 * 以后转成独立 App 时，只替换这个文件（见 spec §14）。
 * ===================================================================== */

const Platform = (() => {
  const caps = { db: null, assets: null, sample: null, downloads: null };
  const hasClaude = !!(window.claude && typeof window.claude.use === 'function');

  const ready = (async () => {
    if (!hasClaude) return caps;
    const names = Object.keys(caps);
    const got = await Promise.all(names.map(n => window.claude.use(n).catch(() => null)));
    names.forEach((n, i) => { caps[n] = got[i] || null; });
    return caps;
  })();

  function norm(e, fallback) {
    if (e && typeof e === 'object' && typeof e.code === 'string') return e;
    return { code: fallback || 'upstream_error', message: String((e && e.message) || e) };
  }
  const unavailable = what => Promise.reject({ code: 'unavailable', message: what + ' not available in this view' });

  /* 同一个文档一次只写一个 */
  const chains = new Map();
  function serial(path, fn) {
    const prev = chains.get(path) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(() => {}, () => {});
    chains.set(path, tail);
    tail.then(() => { if (chains.get(path) === tail) chains.delete(path); });
    return next.catch(e => { throw norm(e); });
  }

  const docOut = s => (s && s.exists ? Object.assign({ id: s.id }, s.data()) : null);

  function buildQuery(coll, o) {
    let q = caps.db.collection(coll);
    for (const w of (o && o.where) || []) q = q.where(w[0], w[1], w[2]);
    if (o && o.orderBy) q = q.orderBy(o.orderBy, o.dir || 'asc');
    if (o && o.limit) q = q.limit(o.limit);
    return q;
  }

  /* ---------- store：文档数据 ---------- */
  const store = {
    get available() { return !!caps.db; },
    async get(path) {
      if (!caps.db) return unavailable('db');
      try { return docOut(await caps.db.doc(path).get()); } catch (e) { throw norm(e); }
    },
    set(path, data) { return caps.db ? serial(path, () => caps.db.doc(path).set(data)) : unavailable('db'); },
    update(path, data) { return caps.db ? serial(path, () => caps.db.doc(path).update(data)) : unavailable('db'); },
    remove(path) { return caps.db ? serial(path, () => caps.db.doc(path).delete()) : unavailable('db'); },
    async query(coll, o) {
      if (!caps.db) return unavailable('db');
      try { return (await buildQuery(coll, o).get()).docs.map(docOut); } catch (e) { throw norm(e); }
    },
    /* 按某个字段倒序分页取全部（导出用） */
    async queryAll(coll, field) {
      const out = [];
      const seen = new Set();
      let before = null;
      for (let i = 0; i < 20; i++) {
        const page = await store.query(coll, { where: before ? [[field, '<=', before]] : [], orderBy: field, dir: 'desc', limit: 1000 });
        let added = 0;
        for (const d of page) if (!seen.has(d.id)) { seen.add(d.id); out.push(d); added++; }
        if (page.length < 1000 || !added) break;
        before = page[page.length - 1][field];
      }
      if (field) {
        /* 没有这个字段的文档不会出现在排序查询里，单独补上 */
        const rest = await store.query(coll, { limit: 1000 }).catch(() => []);
        for (const d of rest) if (!seen.has(d.id)) { seen.add(d.id); out.push(d); }
      }
      return out;
    },
    watch(coll, o, next, onErr) {
      if (!caps.db) return () => {};
      return buildQuery(coll, o).onSnapshot(s => next(s.docs.map(docOut)), e => onErr && onErr(norm(e)));
    },
    watchDoc(path, next, onErr) {
      if (!caps.db) return () => {};
      return caps.db.doc(path).onSnapshot(s => next(docOut(s)), e => onErr && onErr(norm(e)));
    },
  };

  /* ---------- blobs：录音文件，以及导出文件 ---------- */
  const blobs = {
    get available() { return !!caps.assets; },
    get canSave() { return !!caps.downloads; },
    async upload(blob, type) {
      if (!caps.assets) return unavailable('assets');
      try { return await caps.assets.upload(blob, type ? { type } : undefined); } catch (e) { throw norm(e); }
    },
    url(id) { return '/_blob/' + id; },
    async fetchText(id) {
      const r = await fetch('/_blob/' + id);
      if (!r.ok) throw { code: r.status === 404 ? 'not_found' : 'upstream_error', message: 'HTTP ' + r.status };
      return r.text();
    },
    async remove(id) {
      if (!caps.assets) return unavailable('assets');
      try { return await caps.assets.delete(id); } catch (e) { throw norm(e); }
    },
    async usage() {
      if (!caps.assets) return unavailable('assets');
      try { return (await caps.assets.list()).usage; } catch (e) { throw norm(e); }
    },
    async saveFile(filename, data) {
      if (!caps.downloads) return unavailable('downloads');
      try { return await caps.downloads.save({ filename, data }); } catch (e) { throw norm(e, 'unavailable'); }
    },
  };

  /* ---------- llm：页面内 Claude ---------- */
  const PERMANENT = ['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'];
  let blocked = null;
  const blockSubs = [];
  async function call(kind, input, o) {
    if (!caps.sample) throw { code: 'unavailable', message: 'sample not available' };
    if (blocked) throw { code: blocked, message: 'blocked for this view' };
    const opts = {};
    if (o.tier) opts.modelTier = o.tier;
    if (o.signal) opts.signal = o.signal;
    if (o.onText) opts.onText = o.onText;
    if (o.cache !== undefined) opts.cache = o.cache;
    try {
      return kind === 'json' ? await caps.sample.json(input, opts) : await caps.sample(input, opts);
    } catch (e) {
      const x = norm(e);
      if (PERMANENT.includes(x.code) && !blocked) {
        blocked = x.code;
        blockSubs.forEach(f => { try { f(x.code); } catch (_) {} });
      }
      throw x;
    }
  }
  const llm = {
    get available() { return !!caps.sample && !blocked; },
    get reason() { return blocked || (caps.sample ? null : 'unavailable'); },
    json(input, o = {}) { return call('json', input, o); },
    text(input, o = {}) { return call('text', input, o); },
    onBlocked(fn) { blockSubs.push(fn); },
  };

  return { ready, hasClaude, store, blobs, llm };
})();
