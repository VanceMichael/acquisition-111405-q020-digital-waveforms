import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startSource, fixtures} from '../provider/server.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

function contains(actual, expected) {
  if (expected === null || typeof expected !== 'object') return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((value, index) => contains(actual[index], value));
  }
  return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => key in actual && contains(actual[key], value));
}

function rowsMatch(actual, expected) {
  const assignments = new Map();
  function assign(expectedIndex, visited) {
    for (let recordIndex = 0; recordIndex < actual.length; recordIndex++) {
      if (visited.has(recordIndex) || !contains(actual[recordIndex], expected[expectedIndex])) continue;
      visited.add(recordIndex);
      if (!assignments.has(recordIndex) || assign(assignments.get(recordIndex), visited)) {
        assignments.set(recordIndex, expectedIndex);
        return true;
      }
    }
    return false;
  }
  return expected.every((record, index) => assign(index, new Set()));
}

for (const scenario of fixtures) {
  test(`新来源：${scenario.name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'feature-'));
    const source = await startSource(scenario.name);
    try {
      const archive = await openArchive(directory);
      let result;
      for (let iteration = 0; iteration < (scenario.runs ?? 1); iteration++) {
        const reopened = await openArchive(directory);
        result = await collect({baseUrl: source.baseUrl, archive: reopened, mode: 'source'});
      }
      const persisted = await openArchive(directory);
      assert.ok(Array.isArray(result.records), 'records保留本次接收结果');
      assert.ok(rowsMatch(result.records, scenario.expected), '缺少来源结果：' + JSON.stringify(scenario.expected));
      for (const forbidden of scenario.forbidden) {
        assert.equal(result.records.some(record => contains(record, forbidden)), false, '不得生成：' + JSON.stringify(forbidden));
      }
      if (!scenario.expected.length) {
        assert.equal(result.complete, false, '缺解释依据时不得声明完整');
        assert.ok(result.issues.length > 0, '必须留下可复核的缺口');
      }
      if ('complete' in scenario) assert.equal(result.complete, scenario.complete);
      for (const required of scenario.requiredRequests ?? []) {
        assert.ok(source.requests().some(request => request.method + ' ' + request.path === required), '缺少来源步骤：' + required);
      }
      for (const prohibited of scenario.prohibitedRequests ?? []) {
        assert.equal(source.requests().some(request => request.path === prohibited), false, '不得访问：' + prohibited);
      }
      if (scenario.maximumRequests) assert.ok(source.requests().length <= scenario.maximumRequests, '遍历应有界');
      assert.ok(source.requests().some(request => request.path !== '/legacy'), '不能拿人工摘要冒充新来源');
      assert.ok(persisted.snapshot().evidence.length > 0, '接收结果保留原文证据');
      await openArchive(directory);
    } finally { await source.close(); await rm(directory, {recursive: true, force: true}); }
  });
}
