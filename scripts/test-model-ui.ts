/** 模型面板与同源传输的离线测试，不调用服务商。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { createLocalModelController, getLocalModelStatus, type ModelFetch } from '../src/controllers/local-model.ts';
import { observeGame } from '../src/controllers/observation.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { ControllerRequest } from '../src/controllers/protocol.ts';
import type { ControllerTurnResult } from '../src/app/controller-turn.ts';
import { openModelPanel } from '../src/ui/model-panel.ts';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const done: ControllerTurnResult = { status: 'turn-ended', requests: 1, appliedActions: 1, rejectedReplies: 0, fallbackUsed: false };
const healthy: ModelFetch = async () => new Response(JSON.stringify({ configured: true, model: 'deepseek-test', message: '就绪' }), { headers: { 'Content-Type': 'application/json' } });

function page() {
  const dom = new JSDOM('<button id="opener">模型操控</button>', { url: 'http://127.0.0.1:5178/' });
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { value: dom.window.document, configurable: true });
  return {
    dom,
    pick: <T extends Element>(selector: string) => dom.window.document.querySelector<T>(selector)!,
    close() {
      dom.window.close();
      if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore);
      else Reflect.deleteProperty(globalThis, 'document');
    },
  };
}

test('同源代理只发送观察请求和取消信号，返回单步数据', async () => {
  const request: ControllerRequest = {
    protocolVersion: 1, requestId: 'test:A:1:1',
    observation: observeGame(createMatch({ ...DEFAULT_CONFIG, aiOpponent: false }, 42), 'A'),
    controls: { allowOrderEdits: false, remainingRequests: 12 },
  };
  const reply = { protocolVersion: 1, requestId: request.requestId, action: { type: 'END_TURN' } };
  const signal = new AbortController().signal;
  const fetcher: ModelFetch = async (url, init) => {
    assert.equal(url, '/api/controller/decide');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.signal, signal);
    assert.deepEqual(JSON.parse(String(init?.body)), request);
    assert.equal(JSON.stringify(init).includes('Authorization'), false);
    return new Response(JSON.stringify(reply));
  };
  assert.deepEqual(await createLocalModelController(fetcher).decide(request, signal), reply);
});

test('HTTP 错误与畸形状态不向界面回显服务端响应', async () => {
  const signal = new AbortController().signal;
  const failing: ModelFetch = async () => new Response('upstream private content', { status: 502 });
  await assert.rejects(() => getLocalModelStatus(signal, failing), (error: Error) => !error.message.includes('private'));
  await assert.rejects(() => createLocalModelController(failing).decide({} as ControllerRequest, signal), (error: Error) => !error.message.includes('private'));
  await assert.rejects(() => getLocalModelStatus(signal, async () => new Response('{"configured":"yes","model":"test","message":"ready"}')));
});

test('检查通过后只运行一批，拒绝与解释文本安全显示', async () => {
  const p = page();
  try {
    let runs = 0;
    const panel = openModelPanel({
      player: 'A', canRun: true, fetcher: healthy, onCancel() {},
      async onRun(handle) {
        runs++;
        handle.update({ type: 'requested', requestId: 'id', turn: 1, player: 'A' });
        handle.update({ type: 'applied', requestId: 'id', action: { type: 'END_TURN' }, explanation: '<img src=x onerror=alert(1)>' });
        handle.update({ type: 'rejected', requestId: 'id', code: 'RULE_REJECTED', message: '<script>secret</script>' });
        return done;
      },
    });
    await tick();
    const run = p.pick<HTMLButtonElement>('[data-act="model-run"]');
    assert.equal(run.disabled, false);
    run.click(); run.click();
    await tick();
    assert.equal(runs, 1);
    assert.equal(run.disabled, true);
    assert.match(p.pick('[data-model-progress]').textContent!, /已交给下一方/);
    assert.match(p.pick('[data-model-events]').textContent!, /<img/);
    assert.equal(p.dom.window.document.querySelector('img, script, [onerror]'), null);
    panel.close();
  } finally { p.close(); }
});

test('未配置、联机或禁用状态不能执行', async () => {
  const p = page();
  try {
    const panel = openModelPanel({ player: 'B', canRun: false, disabledReason: '联机暂不可用', fetcher: healthy, async onRun() { throw new Error('不得执行'); }, onCancel() {} });
    await tick();
    assert.equal(p.pick<HTMLButtonElement>('[data-act="model-run"]').disabled, true);
    assert.equal(p.pick('[data-model-disabled]').textContent, '联机暂不可用');
    panel.close();
    const unavailable = openModelPanel({ player: 'A', canRun: true, fetcher: async () => new Response(JSON.stringify({ configured: false, model: 'test', message: '没有凭证' })), async onRun() { throw new Error('不得执行'); }, onCancel() {} });
    await tick();
    assert.equal(p.pick<HTMLButtonElement>('[data-act="model-run"]').disabled, true);
    unavailable.close();
  } finally { p.close(); }
});

test('运行中暂停与关闭只中止一次；迟到状态不会重建面板', async () => {
  const p = page();
  try {
    let cancels = 0;
    let finish!: (result: ControllerTurnResult) => void;
    const opener = p.pick<HTMLButtonElement>('#opener');
    opener.focus();
    const panel = openModelPanel({ player: 'A', canRun: true, fetcher: healthy, onRun: () => new Promise((resolve) => { finish = resolve; }), onCancel: () => { cancels++; } });
    await tick();
    p.pick<HTMLButtonElement>('[data-act="model-run"]').click();
    await tick();
    p.pick<HTMLButtonElement>('[data-act="model-cancel"]').click();
    panel.close();
    assert.equal(cancels, 1);
    assert.equal(p.dom.window.document.activeElement, opener);
    finish({ ...done, status: 'cancelled' });
    await tick();
    assert.equal(p.dom.window.document.querySelector('.model-mask'), null);
  } finally { p.close(); }
});

test('关闭时取消连接检查，Escape 可关闭面板', async () => {
  const p = page();
  try {
    let signal: AbortSignal | undefined;
    const panel = openModelPanel({ player: 'A', canRun: true, fetcher: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return new Promise(() => {});
    }, async onRun() { return done; }, onCancel() {} });
    p.dom.window.document.dispatchEvent(new p.dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert.equal(signal?.aborted, true);
    assert.equal(p.dom.window.document.querySelector('.model-mask'), null);
    panel.close();
  } finally { p.close(); }
});
