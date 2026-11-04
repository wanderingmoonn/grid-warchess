/**
 * 水挡路体检：把"规则层的真相"和"各处旁路判断"摆在一起对账。
 *
 * 起因是一句反馈——"寻路判定依然会被水挡住"。规则层的 reachableTiles 早就
 * 按兵种判了地形（见 terrainOk），所以这类 bug 只会活在**旁路判断**里：
 * 出兵位、出城判定、下船落点、产兵面板、AI 的距离图。它们各自写了一遍
 * `passable(t.terrain)`，而 `passable` 说的是"陆军能不能走"。
 *
 * 这个脚本只做三件事，全部是"能不能"的二元判断，不下结论、不修东西：
 *   ① 可达格：跨水的兵种能不能走到对岸，陆军会不会被放过去；
 *   ② 真的走：可达格里最远的那一格，applyAction 收不收；
 *   ③ 出兵位：四面环水的军营，飞行兵算不算"有地方出兵"。
 *
 * 运行：node --experimental-strip-types scripts/probe-water.ts
 */

// @ts-nocheck
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import { airLayer, applyAction, canStandAt, crossesWater, recruitSpawnCells, reachableTiles } from '../src/core/rules.ts';
import { placeUnit } from '../src/core/sandbox.ts';
import type { GameState } from '../src/core/types.ts';

const EXPANSIONS = ['air-corps', 'fantasy-beasts', 'naval-fleet'];

function world(): GameState {
  const s = createMatch({ ...DEFAULT_CONFIG, ...{ expansionIds: EXPANSIONS } } as never, 424242);
  s.units = [];
  // 竖着一条两格宽的水带：x = 5,6 是水，两边都是平原
  for (let y = 0; y < s.h; y++) {
    for (let x = 0; x < s.w; x++) {
      s.tiles[y * s.w + x].terrain = x === 5 || x === 6 ? 'water' : 'plain';
      s.tiles[y * s.w + x].cityId = undefined;
    }
  }
  s.cities = [];
  s.current = 'A';
  s.players.A.gold = 9999;
  return s;
}

const s = world();
const midY = Math.floor(s.h / 2);

/** 把兵放在水带左边，看它能不能摸到右边 */
function bridgeTest(): Array<{ type: string; name: string; can: boolean; reachRight: boolean; moves: boolean }> {
  const rows = [];
  for (const def of Object.values(s.unitTypes)) {
    if (def.category === 'building' || def.summonedOnly) continue;
    const startX = 4;
    if (!canStandAt(s, startX, midY, def.id)) continue;
    const t = structuredClone(s);
    const r = placeUnit(t, 'A', def.id, startX, midY);
    if (!r.ok) continue;
    const unit = r.state.units[r.state.units.length - 1];
    const reach = reachableTiles(r.state, unit);
    let rightmost = null;
    for (const i of reach.keys()) {
      const x = i % r.state.w;
      if (x >= 6 && (rightmost === null || x > (rightmost % r.state.w))) rightmost = i;
    }
    // 真走一步：可达格里最远的那一格
    let moves = false;
    if (rightmost !== null) {
      const act = applyAction(r.state, { type: 'MOVE', unitId: unit.id, x: rightmost % r.state.w, y: Math.floor(rightmost / r.state.w) }, 'A');
      moves = act.ok === true;
      if (!moves) rows.push({ type: def.id, name: def.name, can: crossesWater(def) || def.domain === 'water', reachRight: true, moves: false, reason: act.reason });
      else rows.push({ type: def.id, name: def.name, can: crossesWater(def) || def.domain === 'water', reachRight: true, moves: true });
    } else {
      rows.push({ type: def.id, name: def.name, can: crossesWater(def) || def.domain === 'water', reachRight: false, moves: false });
    }
  }
  return rows;
}

const rows = bridgeTest();
console.log('① 跨水能力 vs 可达格（水带在 x=5,6，起点 x=4，进到 x>=6 算过水）');
console.log('兵种'.padEnd(18), '能跨水', '到对岸', '真能走');
let bad = 0;
for (const r of rows) {
  const mismatch = r.can !== r.reachRight || (r.reachRight && !r.moves);
  if (mismatch) bad++;
  if (mismatch || r.can) {
    console.log(
      `${r.name}(${r.type})`.padEnd(20),
      String(r.can).padEnd(6),
      String(r.reachRight).padEnd(6),
      String(r.moves).padEnd(6),
      mismatch ? `  ← 不一致 ${r.reason ?? ''}` : '',
    );
  }
}
console.log(`不一致 ${bad} 条 / 共 ${rows.length} 个兵种\n`);

// ③ 四面环水的军营，飞行兵算不算"有地方出兵"
console.log('③ 四面环水的军营：出兵位');
const c = structuredClone(s);
for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) c.tiles[y * c.w + x].terrain = 'water';
// 军营只占一格：把它脚下的那一格留成平原，四邻全是水
c.tiles[midY * c.w + 3].terrain = 'plain';
const camp = placeUnit(c, 'A', 'camp', 3, midY);
if (!camp.ok) {
  console.log('  军营摆不下：', camp.reason);
} else {
  const campId = camp.state.units[camp.state.units.length - 1].id;
  for (const def of Object.values(camp.state.unitTypes)) {
    if (def.category === 'building') continue;
    const cells = recruitSpawnCells(camp.state, undefined, campId, def.id);
    const standable = cells.length > 0;
    const should = def.domain === 'water' ? false : airLayer(def) || crossesWater(def);
    if (should || standable) {
      console.log(`  ${def.name}(${def.id})`.padEnd(24), `出兵格 ${cells.length}`, standable ? '' : '  ← 说没地方');
    }
  }
}
