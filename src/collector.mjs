import {createTransport} from './transport.mjs';
import {normalizeLegacy} from './legacy.mjs';
import {createVcdDecoder} from './vcd.mjs';

function validateIndex(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('波形索引不是对象');
  }
  if (typeof payload.runId !== 'string' || !payload.runId.trim()) {
    throw new Error('波形索引缺少runId');
  }
  if (!Array.isArray(payload.chunks) || payload.chunks.some(chunk => typeof chunk !== 'string' || !chunk)) {
    throw new Error('波形索引的chunks无效');
  }
  if (typeof payload.sealed !== 'boolean') {
    throw new Error('波形索引缺少sealed标志');
  }
  return payload;
}

function resolveChunkUrl(baseUrl, chunkPath) {
  try {
    return new URL(chunkPath, baseUrl);
  } catch {
    return null;
  }
}

async function collectSource({baseUrl, archive}) {
  const transport = createTransport(baseUrl);
  const indexUrl = new URL('/waveform', baseUrl).href;
  async function fail(message, kind, extra = {}) {
    const issues = [{kind, message, url: indexUrl, ...extra}];
    await archive.commit({records: [], exchanges: transport.exchanges, issues});
    throw new Error(message);
  }
  const indexResponse = await transport.request('/waveform');
  if (!indexResponse.ok) {
    await fail(`波形索引领取失败：${indexResponse.status}`, 'index-unavailable', {status: indexResponse.status});
  }
  let index;
  try {
    index = validateIndex(indexResponse.json());
  } catch (error) {
    await fail(`波形索引无法解释：${error.message}`, 'invalid-index');
  }

  const decoder = createVcdDecoder({runId: index.runId});
  let truncation = null;
  for (const [position, chunkPath] of index.chunks.entries()) {
    const resolved = resolveChunkUrl(baseUrl, chunkPath);
    if (!resolved || resolved.origin !== transport.origin) {
      truncation = {chunk: position, url: resolved?.href ?? chunkPath, reason: '分块链接越界'};
      decoder.issue('chunk-out-of-origin', `波形分块链接越界：${chunkPath}`, undefined, undefined, truncation);
      break;
    }
    let response;
    try {
      response = await transport.request(chunkPath);
    } catch (error) {
      truncation = {chunk: position, url: resolved.href, reason: error.message};
      decoder.issue('chunk-unavailable', `波形分块领取失败：${error.message}`, undefined, undefined, truncation);
      break;
    }
    if (!response.ok) {
      truncation = {chunk: position, url: resolved.href, status: response.status};
      decoder.issue('chunk-unavailable', `波形分块领取失败：${chunkPath} 返回 ${response.status}`, undefined, undefined, truncation);
      break;
    }
    decoder.push({index: position, url: resolved.href, bytes: response.bytes});
  }

  if (!index.sealed) {
    decoder.issue('unsealed-run', '来源尚未封存，后续分块可能仍未到达', undefined, undefined, {url: indexUrl});
  }
  if (truncation) decoder.issue('incomplete-run', '分块未全部到达，波形解释不完整', undefined, undefined, {chunk: truncation.chunk});
  const ended = index.sealed && !truncation;
  const {records, incomplete, issues} = decoder.finish({eof: ended});
  const complete = ended && !incomplete;
  await archive.commit({records, exchanges: transport.exchanges, issues});
  return {runId: index.runId, records, complete, issues, evidenceCount: transport.exchanges.length};
}

export async function collect({baseUrl, archive, mode = 'legacy'}) {
  if (mode === 'legacy') {
    const transport = createTransport(baseUrl);
    const response = await transport.request('/legacy');
    if (!response.ok) throw new Error(`摘要领取失败：${response.status}`);
    const records = [normalizeLegacy(response.json())];
    await archive.commit({records, exchanges: transport.exchanges});
    return {records, complete: true, issues: [], evidenceCount: transport.exchanges.length};
  }
  if (mode === 'source') return collectSource({baseUrl, archive});
  throw new Error(`未知的领取模式：${mode}`);
}
