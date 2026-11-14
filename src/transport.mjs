export function createTransport(baseUrl, options = {}) {
  const root = new URL(baseUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(root.hostname)) throw new Error('仅允许本地合成来源');
  const exchanges = [];
  const maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024;
  async function request(path, requestOptions = {}) {
    const url = new URL(path, root);
    if (url.origin !== root.origin) throw new Error('来源链接越界');
    const headers = new Headers(requestOptions.headers);
    let body = requestOptions.body;
    if (body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body)) {
      body = JSON.stringify(body);
      headers.set('content-type', 'application/json');
    }
    const response = await fetch(url, {
      ...requestOptions, headers, body, redirect: 'error', signal: AbortSignal.timeout(3000)
    });
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > maximumBytes) throw new Error('资料超过本地接收上限');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    const exchange = {
      url: url.href, method: requestOptions.method ?? 'GET', status: response.status,
      headers: Object.fromEntries(response.headers), bytes
    };
    exchanges.push(exchange);
    return {
      status: response.status, ok: response.ok, headers: response.headers, bytes,
      text: () => bytes.toString('utf8'), json: () => JSON.parse(bytes.toString('utf8'))
    };
  }
  return {request, exchanges, origin: root.origin};
}
