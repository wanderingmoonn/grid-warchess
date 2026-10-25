/** 页面级模型生命周期回归，使用内存代理，不发真实 API 请求。 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';
import type { ControllerRequest } from '../src/controllers/protocol.ts';

const bundle = await build({ entryPoints: ['src/main.ts'], bundle: true, format: 'iife', write: false,
  loader: { '.css': 'text' }, target: 'es2022', logLevel: 'silent' });
const code = bundle.outputFiles[0]!.text;
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function harness(decide: (request: ControllerRequest, signal: AbortSignal) => Promise<unknown>) {
  const dom = new JSDOM('<!doctype html><div id="app"></div>', {
    url: 'http://127.0.0.1:5178/', pretendToBeVisual: true, runScripts: 'outside-only',
  });
  const state = createMatch({ ...DEFAULT_CONFIG, aiOpponent: true }, 207);
  state.aiControl = { A: false, B: true };
  const win = dom.window;
  Object.assign(win, { structuredClone, TextEncoder, TextDecoder });
  win.localStorage.setItem('warchess:match:v1', JSON.stringify(state));
  const requests: ControllerRequest[] = [];
  Object.assign(win, { fetch: async (url: string, init?: RequestInit) => {
    if (url.endsWith('/status')) return { ok: true, json: async () => ({ configured: true, model: 'offline-test', message: '离线代理' }) };
    const request = JSON.parse(init!.body as string) as ControllerRequest;
    requests.push(request);
    const result = await decide(request, init!.signal!);
    return { ok: true, json: async () => win.JSON.parse(JSON.stringify(result)) as unknown };
  } });
  win.eval(code);
  const click = (selector: string) => {
    const element = win.document.querySelector<HTMLElement>(selector);
    assert.ok(element, selector);
    element.click();
  };
  const saved = () => JSON.parse(win.localStorage.getItem('warchess:match:v1')!) as GameState;
  const open = async () => { click('[data-act="model-controller"]'); await tick(); };
  return { dom, win, requests, click, saved, open };
}

test('模型结束一回合后保存并暂停，不自动调用下一方的算法 AI', async () => {
  const h = harness(async (request) => ({ protocolVersion: 1, requestId: request.requestId, action: { type: 'END_TURN' } }));
  try {
    const initial = h.saved();
    await h.open();
    h.click('[data-act="model-run"]');
    await new Promise((resolve) => setTimeout(resolve, 350));
    const saved = h.saved();
    assert.equal(saved.current, 'B');
    assert.equal(saved.turn, 2);
    assert.equal(h.requests.length, 1);
    assert.equal(saved.units.length, initial.units.length);
    assert.match(h.win.document.querySelector('[data-model-progress]')!.textContent!, /本回合已结束/);
    h.click('[data-act="model-close"]');
    await h.open();
    assert.match(h.win.document.querySelector('[data-model-side]')!.textContent!, /敌方/);
  } finally { h.dom.window.close(); }
});

test('模型等待时阻止人工行动和迷雾变更，关闭立即取消，迟到回复不能执行', async () => {
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  const h = harness(async (_request, currentSignal) => {
    signal = currentSignal;
    return new Promise((done) => { resolve = done; });
  });
  try {
    await h.open();
    h.click('[data-act="model-run"]');
    await tick();
    const before = h.saved();
    h.click('[data-act="toggle-fog"]');
    h.click('[data-act="end-turn"]');
    assert.deepEqual(h.saved(), before);
    h.click('[data-act="model-close"]');
    assert.equal(signal.aborted, true);
    resolve({ protocolVersion: 1, requestId: h.requests[0]!.requestId, action: { type: 'END_TURN' } });
    await tick();
    assert.deepEqual(h.saved(), before);
    await h.open();
    assert.ok(h.win.document.querySelector('[data-act="model-run"]'));
  } finally { h.dom.window.close(); }
});

test('等待模型时导入新局会取消旧任务，旧 finally 和回复不能覆盖新存档', async () => {
  let resolve!: (value: unknown) => void;
  let signal!: AbortSignal;
  const h = harness(async (_request, currentSignal) => {
    signal = currentSignal;
    return new Promise((done) => { resolve = done; });
  });
  try {
    await h.open();
    h.click('[data-act="model-run"]');
    await tick();
    const replacement = createMatch({ ...DEFAULT_CONFIG }, 98765);
    h.win.prompt = () => JSON.stringify({ kind: 'warchess-match', version: 1, state: replacement });
    h.click('[data-act="import"]');
    const imported = h.saved();
    assert.equal(signal.aborted, true);
    assert.equal(h.win.document.querySelector('.model-mask'), null);
    resolve({ protocolVersion: 1, requestId: h.requests[0]!.requestId, action: { type: 'END_TURN' } });
    await tick();
    assert.deepEqual(h.saved(), imported);
    assert.equal(h.saved().current, 'A');
  } finally { h.dom.window.close(); }
});
