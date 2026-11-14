import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  if (mode !== 'legacy') throw new Error('当前版本仅支持人工摘要来源');
  const transport = createTransport(baseUrl);
  const response = await transport.request('/legacy');
  if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
  const records = [normalizeLegacy(response.json())];
  await archive.commit({records, exchanges: transport.exchanges});
  return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
}
