import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename} from 'node:fs/promises';
import {join} from 'node:path';

export const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function atomicWrite(path, content) {
  const temporary = `${path}.${randomUUID()}.partial`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function openArchive(directory) {
  await mkdir(join(directory, 'raw'), {recursive: true});
  const indexPath = join(directory, 'index.json');
  let state = {schema: 1, records: [], evidence: [], issues: []};
  try { state = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (state.schema !== 1 || !Array.isArray(state.records) || !Array.isArray(state.evidence)) {
    throw new Error('资料索引版本或结构无效');
  }
  for (const item of state.evidence) {
    if (!/^[a-f0-9]{64}$/.test(item.hash)) throw new Error('资料索引摘要无效');
    if (digest(await readFile(join(directory, 'raw', item.hash))) !== item.hash) throw new Error('原文摘要不匹配');
  }
  let tail = Promise.resolve();
  return {
    snapshot: () => structuredClone(state),
    async raw(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('原文引用无效');
      const bytes = await readFile(join(directory, 'raw', hash));
      if (digest(bytes) !== hash) throw new Error('原文损坏');
      return bytes;
    },
    commit({records = [], exchanges = [], issues = []}) {
      const operation = tail.then(async () => {
        const next = structuredClone(state);
        for (const exchange of exchanges) {
          const hash = digest(exchange.bytes);
          await atomicWrite(join(directory, 'raw', hash), exchange.bytes);
          const item = {url: exchange.url, method: exchange.method, status: exchange.status, headers: exchange.headers, hash};
          const receipt = digest(Buffer.from(JSON.stringify(item)));
          if (!next.evidence.some(previous => previous.receipt === receipt)) next.evidence.push({...item, receipt});
        }
        for (const record of records) {
          if (typeof record.id !== 'string' || !record.id) throw new Error('资料缺少归档标识');
          const revision = digest(Buffer.from(JSON.stringify(record)));
          if (!next.records.some(previous => previous.id === record.id && previous.revision === revision)) {
            next.records.push({...structuredClone(record), revision});
          }
        }
        next.issues.push(...structuredClone(issues));
        await atomicWrite(indexPath, JSON.stringify(next, null, 2) + '\n');
        state = next;
        return structuredClone(state);
      });
      tail = operation.catch(() => {});
      return operation;
    }
  };
}
