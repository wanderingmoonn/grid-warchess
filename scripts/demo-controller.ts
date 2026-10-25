/** 完全离线：脚本控制器演示生产、拒绝重复生产、反馈后结束回合。 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { executeControllerTurn, type ControllerEvent } from '../src/app/controller-turn.ts';
import { CONTROLLER_INSTRUCTIONS } from '../src/controllers/instructions.ts';
import { CONTROLLER_REPLY_SCHEMA, type ControllerReply, type ControllerRequest, type GameController } from '../src/controllers/protocol.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { isValidState } from '../src/storage/validation.ts';

let state = createMatch({ ...DEFAULT_CONFIG, size: 12, commanderMode: true, expansionIds: [], aiAlly: false, aiOpponent: false }, 20261025);
state.units = [];
state.players.A.gold = 1000;
delete state.orders;
const requests: ControllerRequest[] = [];
const replies: ControllerReply[] = [];
const events: ControllerEvent[] = [];

const controller: GameController = {
  id: 'offline-scripted-demo',
  async decide(request, signal) {
    assert.equal(signal.aborted, false);
    requests.push(structuredClone(request));
    const home = request.observation.cities.find((city) => city.owner === request.observation.player)!;
    // 第二次故意重复生产，展示规则拒绝与后续反馈；这不是大模型推理。
    const reply: ControllerReply = {
      protocolVersion: 1, requestId: request.requestId,
      action: requests.length <= 2
        ? { type: 'RECRUIT', cityId: home.id, unitType: 'militia' }
        : { type: 'END_TURN' },
      explanation: requests.length === 1 ? '补充一支民兵。'
        : requests.length === 2 ? '离线测试：尝试再次招募，验证共享产能限制。' : '已收到产能限制反馈，结束本回合。',
    };
    replies.push(structuredClone(reply));
    return JSON.stringify(reply);
  },
};

const result = await executeControllerTurn({
  getState: () => state,
  setState: (next) => { state = next; },
  active: () => true,
  save: () => { assert.ok(isValidState(state)); },
  render: () => {},
  sleep: async () => {},
  onEvent: (event) => { events.push(event); },
}, controller, { maxRequests: 3 });

assert.equal(result.status, 'turn-ended');
assert.equal(result.appliedActions, 2);
assert.equal(result.rejectedReplies, 1);
assert.equal(result.fallbackUsed, false);
assert.equal(requests[1]!.observation.self.production.recruited, 1);
assert.equal(requests[2]!.feedback!.code, 'RULE_REJECTED');
assert.equal(state.units.filter((unit) => unit.owner === 'A').length, 1);
assert.equal(state.current, 'B');
assert.equal(state.players.A.gold, 1000 - requests[0]!.observation.self.recruitCosts.militia!);

console.log('离线控制器演示（未使用大模型，未发出网络请求）');
for (const event of events) {
  if (event.type === 'applied') console.log(`成功：${event.action.type}`);
  else if (event.type === 'rejected') console.log(`拒绝：${event.code}`);
}
console.log(`结果：${result.status}；请求 ${result.requests} 次；成功 ${result.appliedActions} 次；拒绝 ${result.rejectedReplies} 次。`);

if (process.argv.includes('--write-examples')) {
  const directory = new URL('../docs/examples/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const files = {
    'controller-request.json': requests[0],
    'controller-response.json': replies[0],
    'controller-feedback.json': requests[2]!.feedback,
    'controller-reply.schema.json': CONTROLLER_REPLY_SCHEMA,
    'controller-demo-result.json': { controller: controller.id, offline: true, result, events },
  };
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(new URL(name, directory), JSON.stringify(contents, null, 2) + '\n', 'utf8');
  }
  await writeFile(new URL('controller-instructions.txt', directory), CONTROLLER_INSTRUCTIONS + '\n', 'utf8');
  console.log('已生成 docs/examples/controller-* 示例（可使用相同命令重建）。');
}
