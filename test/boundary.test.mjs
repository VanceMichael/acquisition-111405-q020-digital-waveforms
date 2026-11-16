import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createVcdDecoder} from '../src/vcd.mjs';
import {collect} from '../src/collector.mjs';
import {openArchive} from '../src/archive.mjs';

function decode(chunks, {sealed = true} = {}) {
  const decoder = createVcdDecoder({runId: 'r'});
  chunks.forEach((text, index) => decoder.push({index, url: `http://source/chunk/${index}`, bytes: Buffer.from(text)}));
  if (!sealed) decoder.issue('unsealed-run', '来源尚未封存');
  return decoder.finish({eof: sealed});
}

const HEADER = '$timescale 1 ns $end\n$scope module top $end\n$var wire 4 ! a $end\n$upscope $end\n$enddefinitions $end\n';

test('分块边界落在词法单元中间时等待后续字节', () => {
  const splits = [
    [HEADER.slice(0, 25), HEADER.slice(25) + '#2\nb10 !\n'],
    [HEADER + '#2\nb1', '0 !\n'],
    [HEADER + '#2\nb10', ' !\n'],
    [HEADER + '#2\nb10 ', '!', '\n']
  ];
  for (const chunks of splits) {
    const {records, incomplete} = decode(chunks);
    assert.equal(incomplete, false);
    assert.equal(records.length, 1);
    assert.equal(records[0].bits, '0010');
    assert.equal(records[0].timePs, '2000');
  }
});

test('未闭合的向量或标量不提前解释', () => {
  const partial = decode([HEADER + '#2\nbx']);
  assert.equal(partial.records.length, 0);
  assert.ok(partial.issues.some(issue => issue.kind === 'incomplete-fragment'));

  const scalar = decode([HEADER + '#2\n1']);
  assert.equal(scalar.records.length, 0);
  assert.ok(scalar.issues.some(issue => issue.kind === 'incomplete-fragment'));
  assert.equal(scalar.incomplete, true);

  const declaration = decode(['$timescale 1 ns $end\n$scope module top $end\n$var wire 1 ! q $end']);
  assert.equal(declaration.records.length, 0);
  assert.ok(declaration.issues.some(issue => issue.kind === 'missing-enddefinitions'));
  assert.equal(declaration.incomplete, true);

  const unclosed = decode(['$timescale 1 ns $end\n$scope module top']);
  assert.equal(unclosed.records.length, 0);
  assert.ok(unclosed.issues.some(issue => issue.kind === 'unclosed-command'));
  assert.equal(unclosed.incomplete, true);
});

test('未知与高阻保持原样并按最高位扩展', () => {
  const {records} = decode([HEADER + '#1\nb1 !\n#2\nb0 !\n#3\nbx !\n#4\nbz !\n#5\nb01 !\n']);
  assert.deepEqual(records.map(record => record.bits), ['0001', '0000', 'xxxx', 'zzzz', '0001']);
});

test('未知与高阻不得转成零', () => {
  const {records} = decode([HEADER + '#1\nbx !\n']);
  assert.equal(records[0].bits, 'xxxx');
  assert.notEqual(records[0].bits, '0000');
});

test('时间换算使用精确整数并保留大时标', () => {
  const body = '$timescale 2 ms $end\n$scope module top $end\n$var wire 1 ! q $end\n$upscope $end\n$enddefinitions $end\n#9007199254740993\n1!\n';
  const {records} = decode([body]);
  assert.equal(records[0].timePs, (9007199254740993n * 2000000000n).toString());
  assert.equal(records[0].timescale.psPerUnit, '2000000000');
});

test('暂停转储的区间标记为suspended，dumpon只恢复明确值', () => {
  const body = HEADER + '#1\n$dumpoff\nbx !\n$end\n#5\n$dumpon\n$end\n#6\nb0011 !\n';
  const {records} = decode([body]);
  assert.deepEqual(records.map(record => [record.timePs, record.bits, record.status]), [
    ['1000', 'xxxx', 'suspended'],
    ['6000', '0011', 'observed']
  ]);
});

test('暂停转储期间没有新值时不得补造观测', () => {
  const body = HEADER + '#1\n$dumpoff\nbx !\n$end\n#2\n#3\n$dumpon\n$end\n#4\nb0101 !\n';
  const {records} = decode([body]);
  assert.deepEqual(records.map(record => [record.timePs, record.status]), [
    ['1000', 'suspended'],
    ['4000', 'observed']
  ]);
  assert.equal(records.some(record => record.timePs === '2000' || record.timePs === '3000'), false);
});

test('$dumpvars在首个时标前按时间零解释', () => {
  const body = HEADER + '$dumpvars\nb1010 !\n$end\n#3\nb0101 !\n';
  const {records} = decode([body]);
  assert.deepEqual(records.map(record => [record.timePs, record.bits]), [['0', '1010'], ['3000', '0101']]);
});

test('每个观察保留原始位置且声明可追溯', () => {
  const {records} = decode([HEADER + '#2\nb10 !\n']);
  const record = records[0];
  assert.equal(record.sourceSpan.length, 5);
  assert.equal(record.sourceSpan.start.offset, HEADER.length + 3);
  assert.equal(record.sourceSpan.start.chunk, 0);
  assert.equal(record.declaration.sourceSpan.start.offset, HEADER.indexOf('$var'));
  assert.equal(record.declaration.code, '!');
  assert.equal(record.signalPath, 'top.a');
});

test('未声明的短代码与声明前的值不生成业务记录', () => {
  const undeclared = decode(['$timescale 1 ns $end\n$enddefinitions $end\n#1\n1?\n']);
  assert.equal(undeclared.records.length, 0);
  assert.ok(undeclared.issues.some(issue => issue.kind === 'undeclared-code'));

  const early = decode(['$timescale 1 ns $end\n#1\n1!\n']);
  assert.equal(early.records.length, 0);
  assert.ok(early.issues.some(issue => issue.kind === 'value-before-definitions'));
});

test('不支持的语法与不兼容的别名宽度留下缺口', () => {
  const unknown = decode([HEADER + '$comment hidden $end\n#1\nb1 !\n']);
  assert.equal(unknown.records.length, 1);
  assert.ok(unknown.issues.some(issue => issue.kind === 'unsupported-command'));

  const conflicting = decode([
    '$timescale 1 ns $end\n$scope module top $end\n$var wire 1 ! q $end\n$var wire 3 ! alias $end\n$upscope $end\n$enddefinitions $end\n#1\n1!\n'
  ]);
  assert.equal(conflicting.records.length, 0);
  assert.equal(conflicting.incomplete, true);
  assert.ok(conflicting.issues.some(issue => issue.kind === 'alias-width-conflict'));
});

test('未封存来源保留已接收部分但complete为false，并持久化缺口', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boundary-'));
  const chunks = ['/chunk/1', '/chunk/2'];
  const server = createServer((request, response) => {
    if (request.url === '/waveform') {
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify({runId: 'r3', chunks, sealed: false}));
      return;
    }
    if (request.url === '/chunk/1') {
      response.writeHead(200, {'content-type': 'text/plain'});
      response.end(HEADER + '#2\nb10 !\n');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const archive = await openArchive(directory);
    const result = await collect({baseUrl, archive, mode: 'source'});
    assert.equal(result.complete, false);
    assert.equal(result.records.length, 1);
    assert.ok(result.issues.some(issue => issue.kind === 'unsealed-run'));
    const stored = archive.snapshot();
    assert.equal(stored.records.length, 1);
    assert.ok(stored.issues.length > 0);
    const repeated = await collect({baseUrl, archive: await openArchive(directory), mode: 'source'});
    assert.equal(repeated.records.length, 1);
    assert.equal((await openArchive(directory)).snapshot().records.length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});
