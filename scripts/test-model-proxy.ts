/** 代理的所有上游请求使用内存 fetch；不读取本机凭证、不调用真实 API。 */
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import type { Server } from 'node:http';
import test from 'node:test';
import { createModelProxy, DEFAULT_DEEPSEEK_MODEL, MODEL_REQUEST_LIMIT } from '../server/model-proxy.ts';
import type { ModelProxyOptions } from '../server/model-proxy.ts';
import { observeGame } from '../src/controllers/observation.ts';
import type { ControllerRequest } from '../src/controllers/protocol.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';

const SENTINEL = 'test-secret-must-never-leak';
function fixture(): ControllerRequest {
  return { protocolVersion: 1, requestId: 'proxy-test:A:1:1',
    observation: observeGame(createMatch(DEFAULT_CONFIG, 207), 'A'),
    controls: { allowOrderEdits: false, remainingRequests: 3 } };
}

const reply = (id = fixture().requestId) => ({ protocolVersion: 1, requestId: id, action: { type: 'END_TURN' } });
function providerResponse(content: unknown = reply(), finish_reason = 'stop'): Response {
  return Response.json({ choices: [{ message: { content: JSON.stringify(content) }, finish_reason }] });
}

async function harness(options: Partial<ModelProxyOptions> = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const middleware = createModelProxy({ enabled: true, env: {}, credential: async () => SENTINEL,
    fetchImpl: async (url, init) => { calls.push({ url: String(url), init: init! }); return providerResponse(); }, ...options });
  const server = createServer((req, res) => {
    void middleware(req, res, () => { res.statusCode = 404; res.end('other route'); });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  const call = async (path: string, body?: string | object, headers: Record<string, string> = {}, method?: string) => {
    const payload = typeof body === 'object' ? JSON.stringify(body) : body;
    return new Promise<{ status: number; text: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request(`${origin}${path}`, { method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, text, headers: res.headers }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  };
  return { server, call, calls };
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test('状态检查只返回就绪标志、公开模型和固定文案', async () => {
  const h = await harness();
  try {
    const r = await h.call('/api/controller/status');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), { configured: true, model: DEFAULT_DEEPSEEK_MODEL, message: '已读取本机凭证，在线可用性以执行结果为准。' });
    assert.equal(h.calls.length, 0);
    assert.equal(r.text.includes(SENTINEL), false);
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally { await close(h.server); }
});

test('单步请求使用固定地址和 JSON 模式，返回经过协议校验的回复', async () => {
  const h = await harness();
  try {
    const input = fixture();
    const r = await h.call('/api/controller/decide', input);
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.text), reply());
    assert.equal(h.calls[0]!.url, 'https://api.deepseek.com/chat/completions');
    assert.equal(h.calls[0]!.init.redirect, 'error');
    const payload = JSON.parse(String(h.calls[0]!.init.body));
    assert.equal(payload.model, DEFAULT_DEEPSEEK_MODEL);
    assert.equal(payload.max_tokens, 512);
    assert.deepEqual(payload.thinking, { type: 'disabled' });
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.deepEqual(JSON.parse(payload.messages[1].content), input);
    assert.match(payload.messages[0].content, /JSON/);
    assert.equal(r.text.includes(SENTINEL), false);
  } finally { await close(h.server); }
});

test('发布环境禁用模型代理并且不读取凭证', async () => {
  let reads = 0;
  const h = await harness({ enabled: false, credential: async () => { reads++; return SENTINEL; } });
  try {
    assert.equal((await h.call('/api/controller/status')).status, 403);
    assert.equal((await h.call('/api/controller/decide', fixture())).status, 403);
    assert.equal(reads, 0);
    assert.equal(h.calls.length, 0);
  } finally { await close(h.server); }
});

test('拒绝跨源、缺少 Origin、DNS 重绑定 Host 和非 JSON 调用', async () => {
  const h = await harness();
  try {
    const unsafeHeaders: Record<string, string>[] = [{ Origin: 'https://evil.example' }, { Origin: '' }, { Host: 'evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const headers of unsafeHeaders) {
      assert.equal((await h.call('/api/controller/decide', fixture(), headers)).status, 403);
    }
    assert.equal((await h.call('/api/controller/decide', fixture(), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal(h.calls.length, 0);
  } finally { await close(h.server); }
});

test('拒绝畸形请求、额外指令字段和过大请求', async () => {
  const h = await harness();
  try {
    assert.equal((await h.call('/api/controller/decide', '{')).status, 400);
    assert.equal((await h.call('/api/controller/decide', { ...fixture(), model: 'other-model' })).status, 400);
    const input = fixture();
    input.observation.current = 'B';
    assert.equal((await h.call('/api/controller/decide', input)).status, 400);
    assert.equal((await h.call('/api/controller/decide', ' '.repeat(MODEL_REQUEST_LIMIT + 1))).status, 413);
    assert.equal(h.calls.length, 0);
  } finally { await close(h.server); }
});

test('缺失凭证不会调用上游', async () => {
  const h = await harness({ credential: async () => null });
  try {
    assert.equal(JSON.parse((await h.call('/api/controller/status')).text).configured, false);
    assert.equal((await h.call('/api/controller/decide', fixture())).status, 503);
    assert.equal(h.calls.length, 0);
  } finally { await close(h.server); }
});

test('凭证读取暂时返回空值或抛错后，下次手动检查可以恢复并缓存成功值', async () => {
  for (const failure of ['empty', 'error']) {
    let reads = 0;
    const h = await harness({ credential: async () => {
      if (++reads > 1) return SENTINEL;
      if (failure === 'error') throw new Error(SENTINEL);
      return null;
    } });
    try {
      const unavailable = await h.call('/api/controller/status');
      assert.equal(JSON.parse(unavailable.text).configured, false);
      assert.equal(unavailable.text.includes(SENTINEL), false);
      assert.equal(JSON.parse((await h.call('/api/controller/status')).text).configured, true);
      assert.equal((await h.call('/api/controller/decide', fixture())).status, 200);
      assert.equal(reads, 2);
      assert.equal(h.calls.length, 1);
    } finally { await close(h.server); }
  }
});

test('同时检查状态共用同一个凭证读取任务', async () => {
  let reads = 0;
  let complete!: (key: string) => void;
  const h = await harness({ credential: async () => {
    reads++;
    return new Promise((resolve) => { complete = resolve; });
  } });
  try {
    const first = h.call('/api/controller/status');
    const second = h.call('/api/controller/status');
    while (!complete) await new Promise((resolve) => setTimeout(resolve, 2));
    complete(SENTINEL);
    const results = await Promise.all([first, second]);
    assert.ok(results.every((result) => JSON.parse(result.text).configured === true));
    assert.equal(reads, 1);
    assert.equal(h.calls.length, 0);
  } finally { await close(h.server); }
});

test('上游401清除成功凭证缓存，下一次手动请求读取新凭证且不自动重试', async () => {
  let reads = 0;
  let attempts = 0;
  const credentials: string[] = [];
  const h = await harness({ credential: async () => `${SENTINEL}-${++reads}`,
    fetchImpl: async (_url, init) => {
      credentials.push((init!.headers as Record<string, string>).Authorization);
      return ++attempts === 1 ? new Response(SENTINEL, { status: 401 }) : providerResponse();
    } });
  try {
    assert.equal(JSON.parse((await h.call('/api/controller/status')).text).configured, true);
    const rejected = await h.call('/api/controller/decide', fixture());
    assert.equal(rejected.status, 502);
    assert.equal(JSON.parse(rejected.text).error.code, 'CREDENTIAL_REJECTED');
    assert.equal(rejected.text.includes(SENTINEL), false);
    assert.equal(reads, 1);
    assert.equal(attempts, 1);
    assert.equal((await h.call('/api/controller/decide', fixture())).status, 200);
    assert.equal(reads, 2);
    assert.equal(attempts, 2);
    assert.deepEqual(credentials, [`Bearer ${SENTINEL}-1`, `Bearer ${SENTINEL}-2`]);
  } finally { await close(h.server); }
});

test('拒绝上游截断、空回复、错误 requestId 和未知动作字段', async () => {
  for (const response of [providerResponse(reply(), 'length'), providerResponse(''), providerResponse(reply('stale')),
    providerResponse({ ...reply(), action: { type: 'END_TURN', hidden: true } })]) {
    const h = await harness({ fetchImpl: async () => response });
    try {
      const r = await h.call('/api/controller/decide', fixture());
      assert.equal(r.status, 502);
      assert.equal(JSON.parse(r.text).error.code, 'INVALID_PROVIDER_REPLY');
      assert.equal(r.text.includes(SENTINEL), false);
    } finally { await close(h.server); }
  }
});

test('上游认证、余额与限流失败仅返回固定安全错误，不回显响应', async () => {
  for (const [status, code] of [[401, 'CREDENTIAL_REJECTED'], [402, 'INSUFFICIENT_BALANCE'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_UNAVAILABLE']] as const) {
    const h = await harness({ fetchImpl: async () => new Response(SENTINEL, { status }) });
    try {
      const r = await h.call('/api/controller/decide', fixture());
      assert.equal(r.status, 502);
      assert.equal(JSON.parse(r.text).error.code, code);
      assert.equal(r.text.includes(SENTINEL), false);
    } finally { await close(h.server); }
  }
});

test('网络异常与超大响应不会泄露原始数据', async () => {
  for (const fetchImpl of [async () => { throw new Error(SENTINEL); }, async () => new Response(SENTINEL.repeat(2000))]) {
    const h = await harness({ fetchImpl });
    try {
      const r = await h.call('/api/controller/decide', fixture());
      assert.equal(r.status, 502);
      assert.equal(r.text.includes(SENTINEL), false);
    } finally { await close(h.server); }
  }
});

test('单次截止时间取消上游请求，释放下一次请求名额', async () => {
  let attempts = 0;
  const h = await harness({ timeoutMs: 30, fetchImpl: async (_url, init) => {
    attempts++;
    if (attempts > 1) return providerResponse();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error(SENTINEL)), { once: true }));
  } });
  try {
    assert.equal((await h.call('/api/controller/decide', fixture())).status, 504);
    assert.equal((await h.call('/api/controller/decide', fixture())).status, 200);
  } finally { await close(h.server); }
});

test('并发与每小时预算均由服务端限制', async () => {
  let finish!: (response: Response) => void;
  const h = await harness({ hourlyLimit: 1, fetchImpl: async () => new Promise((resolve) => { finish = resolve; }) });
  try {
    const first = h.call('/api/controller/decide', fixture());
    while (!finish) await new Promise((resolve) => setTimeout(resolve, 2));
    const concurrent = await h.call('/api/controller/decide', fixture());
    assert.equal(concurrent.status, 429);
    assert.equal(JSON.parse(concurrent.text).error.code, 'BUSY');
    finish(providerResponse());
    assert.equal((await first).status, 200);
    const budget = await h.call('/api/controller/decide', fixture());
    assert.equal(budget.status, 429);
    assert.equal(JSON.parse(budget.text).error.code, 'REQUEST_BUDGET');
  } finally { await close(h.server); }
});

test('页面断开连接时取消上游，迟到回复不会进入下一次调用', async () => {
  let cancelled!: () => void;
  const observed = new Promise<void>((resolve) => { cancelled = resolve; });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let attempts = 0;
  const h = await harness({ fetchImpl: async (_url, init) => {
    if (++attempts > 1) return providerResponse();
    started();
    return new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => { cancelled(); reject(new Error('cancel')); }, { once: true }));
  } });
  try {
    const address = h.server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    const req = request(`${origin}/api/controller/decide`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } });
    req.on('error', () => {});
    req.end(JSON.stringify(fixture()));
    await ready;
    req.destroy();
    await observed;
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await h.call('/api/controller/decide', fixture())).status, 200);
  } finally { await close(h.server); }
});

test('未完成请求体也受截止时间约束，不会永久占用并发名额', async () => {
  const h = await harness({ timeoutMs: 35 });
  try {
    const address = h.server.address() as { port: number };
    const origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) => {
      const req = request(`${origin}/api/controller/decide`, { method: 'POST', headers: {
        Origin: origin, 'Content-Type': 'application/json', 'Content-Length': '1000',
      } });
      const deadline = setTimeout(() => { req.destroy(); reject(new Error('upload was not bounded')); }, 2000);
      req.on('error', () => { clearTimeout(deadline); resolve(); });
      req.write('{');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await h.call('/api/controller/decide', fixture())).status, 200);
    assert.equal(h.calls.length, 1);
  } finally { await close(h.server); }
});
