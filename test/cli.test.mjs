import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {legacy} from '../provider/server.mjs';

const execute = promisify(execFile);

test('CLI实际领取、重复导入及独立进程归档检查', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cli-baseline-'));
  const environment = {...process.env, ARCHIVE_DIR: directory};
  delete environment.SOURCE_URL;
  delete environment.SCENARIO;
  async function invoke(command) {
    const result = await execute(process.execPath, ['src/cli.mjs', command], {
      env: environment, timeout: 15000, maxBuffer: 1024 * 1024,
    });
    assert.equal(result.stderr, '');
    return JSON.parse(result.stdout);
  }
  try {
    const first = await invoke('collect');
    assert.equal(first.mode, 'legacy');
    assert.equal(first.complete, true);
    assert.deepEqual(first.records, [legacy]);
    assert.equal(first.stored, 1);
    assert.ok(first.evidenceCount > 0);
    const repeated = await invoke('collect');
    assert.equal(repeated.stored, 1);
    const persisted = await invoke('inspect');
    assert.equal(persisted.records.length, 1);
    assert.ok(persisted.evidence.length > 0);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
