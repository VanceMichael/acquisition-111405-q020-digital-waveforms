import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource, legacy, fixtures} from '../provider/server.mjs';
import {openArchive} from '../src/archive.mjs';
import {collect} from '../src/collector.mjs';
import {createTransport} from '../src/transport.mjs';

test('人工摘要导入保留字段、重复收件不增加同一修订', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'baseline-'));
  const source = await startSource();
  try {
    const archive = await openArchive(directory);
    const first = await collect({baseUrl: source.baseUrl, archive});
    assert.equal(first.complete, true);
    assert.deepEqual(first.records[0], legacy);
    await collect({baseUrl: source.baseUrl, archive});
    assert.equal(archive.snapshot().records.length, 1);
    const reopened = await openArchive(directory);
    assert.equal(reopened.snapshot().records.length, 1);
    const evidence = reopened.snapshot().evidence[0];
    assert.deepEqual(JSON.parse(await reopened.raw(evidence.hash)), legacy);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});

test('来源越界不发请求，错误响应保留原文', async () => {
  const source = await startSource();
  try {
    const transport = createTransport(source.baseUrl);
    await assert.rejects(transport.request('https://example.invalid/private'), /越界/);
    const missing = await transport.request('/not-a-source');
    assert.equal(missing.status, 404);
    assert.equal(transport.exchanges.length, 1);
  } finally { await source.close(); }
});

test('资料来源的每个公开路径可独立读取其声明响应', async () => {
  for (const scenario of fixtures) {
    const source = await startSource(scenario.name);
    try {
      for (const route of scenario.routes) {
        if (route.method !== 'GET' || route.after || route.once || route.denyAfter) continue;
        const response = await fetch(source.baseUrl + route.path);
        assert.equal(response.status, route.status, scenario.name + route.path);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (route.body && '$hex' in Object(route.body)) assert.equal(bytes.toString('hex'), route.body.$hex);
        else if (typeof route.body === 'string') assert.equal(bytes.toString('utf8'), route.body);
        else if (route.body && '$octets' in Object(route.body)) assert.ok(bytes.length > 0);
        else assert.deepEqual(JSON.parse(bytes), route.body);
      }
    } finally { await source.close(); }
  }
});

test('原文损坏不静默继续', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'integrity-'));
  const source = await startSource();
  try {
    const archive = await openArchive(directory);
    await collect({baseUrl: source.baseUrl, archive});
    await writeFile(join(directory, 'raw', archive.snapshot().evidence[0].hash), 'corrupted');
    await assert.rejects(openArchive(directory), /摘要不匹配/);
  } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
});
