export function normalizeLegacy(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('摘要不是对象');
  if (typeof payload.id !== 'string' || !payload.id.trim()) throw new Error('摘要缺少来源标识');
  return structuredClone(payload);
}
