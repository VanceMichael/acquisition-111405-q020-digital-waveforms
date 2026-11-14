import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

export const fixtures = JSON.parse(await readFile(new URL('../fixtures/scenarios.json', import.meta.url), 'utf8'));
export const legacy = JSON.parse(await readFile(new URL('../fixtures/legacy.json', import.meta.url), 'utf8'));

function encode(body) {
  if (body && typeof body === 'object' && '$hex' in body) return {bytes: Buffer.from(body.$hex, 'hex'), type: 'application/octet-stream'};
  if (body && typeof body === 'object' && '$octets' in body) {
    const bytes = Buffer.concat(body.$octets.map(text => {
      const content = Buffer.from(text);
      return Buffer.concat([Buffer.from(String(content.length) + ' '), content]);
    }));
    return {bytes, type: 'application/octet-stream'};
  }
  if (typeof body === 'string') return {bytes: Buffer.from(body), type: 'text/plain; charset=utf-8'};
  return {bytes: Buffer.from(JSON.stringify(body)), type: 'application/json'};
}

function validateExpression(expression, capabilities) {
  if (expression === null || expression === undefined) return true;
  if (!expression || typeof expression !== 'object' || Array.isArray(expression)) return false;
  const keys = Object.keys(expression);
  if (keys.length !== 1) return false;
  const operator = keys[0];
  if (operator === 'or' || operator === 'and') {
    if (operator === 'or' && !capabilities.supportsOr) return false;
    return Array.isArray(expression[operator]) && expression[operator].length > 0 && expression[operator].every(child => validateExpression(child, capabilities));
  }
  if (operator === 'not') return capabilities.operators.includes('not') && validateExpression(expression.not, capabilities);
  const pair = expression[operator];
  return capabilities.operators.includes(operator) && Array.isArray(pair) && pair.length === 2 && capabilities.fields.includes(pair[0]);
}

function sourceMatches(expression, fields) {
  if (expression === null || expression === undefined) return true;
  if ('and' in expression) return expression.and.every(child => sourceMatches(child, fields));
  if ('or' in expression) return expression.or.some(child => sourceMatches(child, fields));
  if ('not' in expression) return !sourceMatches(expression.not, fields);
  const operator = Object.keys(expression)[0];
  const [field, expected] = expression[operator];
  if (!(field in fields)) return false;
  if (operator === 'eq') return fields[field] === expected;
  return typeof fields[field] === 'string' && fields[field].normalize('NFC').toLocaleLowerCase('und').includes(String(expected).normalize('NFC').toLocaleLowerCase('und'));
}

export async function startSource(scenarioName = fixtures[0].name) {
  const scenario = fixtures.find(item => item.name === scenarioName);
  if (!scenario) throw new Error(`未知资料情景：${scenarioName}`);
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = [];
      let total = 0;
      for await (const chunk of request) {
        total += chunk.length;
        if (total > 1024 * 1024) { response.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/__requests') {
        response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(requests));
        return;
      }
      const entry = {method: request.method, path: request.url, body, sequence: requests.length};
      const earlier = requests.slice();
      requests.push(entry);
      if (request.method === 'GET' && url.pathname === '/legacy') {
        response.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(legacy));
        return;
      }
      const matches = scenario.routes.filter(item => item.method === request.method && item.path === request.url);
      const count = earlier.filter(item => item.method === request.method && item.path === request.url).length;
      const selected = matches[Math.min(count, matches.length - 1)];
      if (!selected) { response.writeHead(404).end('未声明的资料接口'); return; }
      if (selected.denyAfter && earlier.some(item => item.method + ' ' + item.path === selected.denyAfter)) {
        response.writeHead(410).end('来源已释放该份原始资料'); return;
      }
      if (selected.after && !earlier.some(item => item.path === selected.after)) {
        response.writeHead(409).end('来源前置步骤尚未完成'); return;
      }
      if (selected.once && count > 0) { response.writeHead(410).end('来源凭证已消耗'); return; }
      let responseBody = selected.body;
      if (request.method === 'POST' && url.pathname.endsWith('/search')) {
        const capabilities = scenario.routes.find(item => item.path === url.pathname.replace(/\/search$/, '/capabilities'))?.body;
        let parsed;
        try { parsed = JSON.parse(body); } catch { response.writeHead(400).end('查询必须是JSON'); return; }
        if (capabilities && !validateExpression(parsed.expr, capabilities)) {
          response.writeHead(422).end('来源不支持该查询表达式'); return;
        }
        if (capabilities) {
          const items = selected.body.items.filter(item => sourceMatches(parsed.expr, item.fields));
          const offset = parsed.cursor === undefined ? 0 : Number(parsed.cursor);
          if (!Number.isInteger(offset) || offset < 0 || (offset && !capabilities.nextSupported)) {
            response.writeHead(400).end('来源游标无效'); return;
          }
          const more = items.length > offset + capabilities.limit;
          responseBody = {...selected.body, items: items.slice(offset, offset + capabilities.limit),
            next: more && capabilities.nextSupported ? String(offset + capabilities.limit) : null,
            truncated: Boolean(selected.body.truncated || (more && !capabilities.nextSupported))};
        }
      }
      const encoded = encode(responseBody);
      response.writeHead(selected.status, {'content-type': encoded.type, 'content-length': encoded.bytes.length, ...selected.headers});
      if (!encoded.bytes.length) { response.end(); return; }
      const split = Math.max(1, Math.floor(encoded.bytes.length / 3));
      for (let offset = 0; offset < encoded.bytes.length; offset += split) response.write(encoded.bytes.subarray(offset, offset + split));
      response.end();
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error.message));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    requests: () => structuredClone(requests),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    })
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = await startSource(process.argv[2]);
  process.stdout.write(JSON.stringify({baseUrl: source.baseUrl}) + '\n');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await source.close(); process.exit(0); });
}
