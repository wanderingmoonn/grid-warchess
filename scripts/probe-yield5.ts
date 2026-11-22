import { DEFAULT_CONFIG, createMatch } from '../src/core/setup.ts';
import { applyAction, recruitSpawnCells } from '../src/core/rules.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import { DEFAULT_BUDGET } from '../src/core/ai.ts';
import { aiNextAction } from '../src/core/ai-v3.ts';

const me = 'A';
let s = createMatch({ ...DEFAULT_CONFIG, size: 10, startEra: 2, mapSymmetry: 'fair' }, 30);
const city = s.cities.find((c) => c.owner === me)!;
console.log('原城', city.id, city.x, city.y, 'size', city.size);

// 把城挪到左上角，并把 5×5 区域改成平地（排除新城格）
s = structuredClone(s);
// 清掉所有单位（双方）；敌城挪到右下角，避免和 5×5 区域重叠
s.units = [];
for (const c of s.cities) {
  if (c.owner === me) continue;
  c.x = 8;
  c.y = 8;
  for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    const t = s.tiles[(8 + dy) * s.w + (8 + dx)];
    if (t) { t.terrain = 'city'; t.cityId = c.id; }
  }
}
const ocx = city.x;
const ocy = city.y;
const c2 = s.cities.find((c) => c.id === city.id)!;
c2.x = 0;
c2.y = 0;
// 整张图先改成平地，保证 5×5 外有可站空地（否则 BFS 找不到目标）
for (let y = 0; y < s.h; y++) {
  for (let x = 0; x < s.w; x++) {
    const t = s.tiles[y * s.w + x]!;
    t.terrain = 'plain';
    (t as { cityId?: string }).cityId = undefined;
  }
}
for (let y = 0; y < 2; y++) {
  for (let x = 0; x < 2; x++) {
    const t = s.tiles[y * s.w + x]!;
    t.terrain = 'city';
    t.cityId = c2.id;
  }
}
// 原城格恢复平地
for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
  const t = s.tiles[(ocy + dy) * s.w + (ocx + dx)];
  if (t && t.terrain === 'city') t.terrain = 'plain';
}

let n = 0;
for (let y = 0; y < 5; y++) {
  for (let x = 0; x < 5; x++) {
    const placed = placeUnit(s, me, 'farmer', x, y);
    if (placed.ok) { s = placed.state; n += 1; }
    else console.log('放不了', x, y, placed.reason);
  }
}
console.log('铺农民', n, '产兵格', recruitSpawnCells(s, c2.id, undefined, 'farmer').length);
s.players[me].gold = 0;

const budget = { ...DEFAULT_BUDGET };
// 3 个回合，每回合最多 12 步，看几回合把产兵格恢复满
for (let round = 1; round <= 3; round++) {
  const rejected = new Set<string>();
  let moves = 0;
  for (let i = 0; i < 60; i++) {
    const a = aiNextAction(s, budget, rejected);
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) { if (a.type !== 'MOVE') { rejected.add('x'); break; } continue; }
    s = r.state;
    if (a.type === 'MOVE') moves += 1;
    if (a.type === 'RECRUIT') budget.recruited += 1;
  }
  console.log(`回合 ${round}：MOVE ${moves} 次，产兵格 ${recruitSpawnCells(s, c2.id, undefined, 'farmer').length}`);
  if (s.winner) break;
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}
for (let y = 0; y < 5; y++) {
  let row = '';
  for (let x = 0; x < 5; x++) {
    const u = s.units.find((z) => z.x === x && z.y === y && z.owner === me);
    row += u ? '农' : '·';
  }
  console.log(row);
}
