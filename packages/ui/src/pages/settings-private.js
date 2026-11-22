// Private Persona/Growth editor presentation. The host owns atomic writes and
// conflict detection; this module only updates labels and disables fake saves.

/** Update one private Markdown editor without overwriting newer local edits. */
export function renderPrivateField(nodes, field, value, { dirty = false, error = '', saving = false, capable = true } = {}) {
  if (!nodes) return;
  if (nodes.input && !dirty) nodes.input.value = value?.markdown ?? '';
  if (nodes.status) {
    nodes.status.textContent = saving
      ? '保存中…'
      : value?.state === 'available' ? '已读取' : value?.state === 'error' ? '读取失败' : '尚未创建';
    nodes.status.dataset.tone = value?.state === 'available' ? 'ready' : value?.state === 'error' ? 'error' : 'unavailable';
  }
  if (nodes.meta) {
    const bits = [];
    if (value?.state === 'available') bits.push(value.sha256 ? `SHA-256 ${value.sha256.slice(0, 12)}…` : '已读取');
    if (error) bits.push(error);
    else if (!capable) bits.push('当前宿主没有提供私有 Agent 保存。');
    else if (value?.state === 'missing') bits.push('保存会创建该文件。');
    nodes.meta.textContent = bits.join(' · ');
    nodes.meta.hidden = bits.length === 0;
    nodes.meta.dataset.tone = error ? 'error' : '';
  }
  if (nodes.save) {
    nodes.save.disabled = !capable || saving;
    nodes.save.textContent = saving ? '正在保存…' : field === 'persona' ? '保存人格' : '保存成长';
    nodes.save.setAttribute('aria-busy', saving ? 'true' : 'false');
  }
}
