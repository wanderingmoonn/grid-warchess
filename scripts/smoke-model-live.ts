/** 显式运行的真实 DeepSeek 联调。只操作内存中的独立测试局，不读写用户存档。 */
import assert from 'node:assert/strict';
import { executeControllerTurn } from '../src/app/controller-turn.ts';
import { createLocalModelController } from '../src/controllers/local-model.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';

const base = new URL(process.env.MODEL_PROXY_URL ?? 'http://127.0.0.1:5178');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), '联调只访问本机代理');
let state = createMatch({ ...DEFAULT_CONFIG, aiOpponent: false }, 207);
const origin = base.origin;
const controller = createLocalModelController((url, init) => fetch(new URL(url, origin), {
  ...init, headers: { ...init?.headers, Origin: origin },
}));
const status = await fetch(new URL('/api/controller/status', origin), { headers: { Origin: origin } });
const connection = await status.json() as { configured?: boolean; model?: string };
assert.ok(status.ok && connection.configured, '请启动本机开发代理并配置 DeepSeek 凭证');
const started = Date.now();
const result = await executeControllerTurn({
  getState: () => state,
  setState: (next) => { state = next; },
  active: () => true,
  save() {}, render() {},
  sleep: async () => {},
  onEvent(event) {
    if (event.type === 'applied') console.log(JSON.stringify({ event: 'applied', action: event.action.type }));
    if (event.type === 'rejected') console.log(JSON.stringify({ event: 'rejected', code: event.code }));
  },
}, controller, { maxRequests: 3, timeoutMs: 35000, failurePolicy: 'stop' });
console.log(JSON.stringify({ model: connection.model, elapsedMs: Date.now() - started, ...result }));
assert.ok(result.appliedActions > 0, '真实模型至少应产生一条通过规则校验的动作');
assert.ok(!['provider-error', 'timeout', 'invalid-replies'].includes(result.status), '真实模型调用未完成预期联调');
