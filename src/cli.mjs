import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSource, fixtures} from '../provider/server.mjs';
import {openArchive} from './archive.mjs';
import {collect} from './collector.mjs';

const command = process.argv[2] ?? 'demo';
const mode = process.argv.includes('--source') ? 'source' : 'legacy';
const scenario = process.env.SCENARIO ?? fixtures[0].name;
const temporary = !process.env.ARCHIVE_DIR;
const directory = process.env.ARCHIVE_DIR ?? await mkdtemp(join(tmpdir(), 'acquisition-'));
let source;
try {
  const archive = await openArchive(directory);
  if (command === 'inspect') {
    console.log(JSON.stringify(archive.snapshot(), null, 2));
  } else if (command === 'demo' || command === 'collect') {
    source = process.env.SOURCE_URL ? null : await startSource(scenario);
    const result = await collect({baseUrl: process.env.SOURCE_URL ?? source.baseUrl, archive, mode});
    console.log(JSON.stringify({mode, scenario, ...result, stored: archive.snapshot().records.length}, null, 2));
  } else {
    throw new Error('支持demo、collect、inspect');
  }
} finally {
  if (source) await source.close();
  if (temporary) await rm(directory, {recursive: true, force: true});
}
