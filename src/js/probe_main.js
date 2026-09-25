/* M0 探针页入口 */
(async () => {
  await Platform.ready;
  const root = document.getElementById('probe-root');
  Probe.mount(root);
  if (!Platform.store.available) {
    root.prepend(h('div', { class: 'notice bad' }, '没有连上 Claude 的 artifact 查看器：数据库、上传和页面内 Claude 都不可用。请在 claude.ai 里打开这个 artifact。'));
  }
})();
