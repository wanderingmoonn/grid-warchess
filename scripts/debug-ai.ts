/**
 * 临时排障脚本：跑到指定回合，把双方单位的位置、离敌方城市的距离、
 * 以及每个单位当前能做的事打出来，看 AI 到底卡在哪一步。
 *
 * 运行：node --experimental-strip-types scripts/debug-ai.ts 25
 */

import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { applyAction, attackableTargets, citiesOf, distToCity, distance, reachableTiles, siegeTargets, unitsOf } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';

const STOP = Number(process.argv[2] ?? 20);
let s: GameState = createMatch({ ...DEFAULT_CONFIG, aiOpponent: true, aiAlly: true }, 20260101);
const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };

for (let turn = 1; turn <= STOP; turn++) {
  budget.recruited = 0;
  budget.upgraded = 0;
  const side = s.current;
  const acts: string[] = [];
  for (let step = 0; step < AI_MAX_STEPS; step++) {
    const a = aiNextAction(s, budget);
    if (!a) break;
    const r = applyAction(s, a);
    if (!r.ok) {
      acts.push(`非法:${a.type}(${r.reason})`);
      break;
    }
    s = r.state;
    if (a.type === 'RECRUIT') budget.recruited += 1;
    if (a.type === 'UPGRADE') budget.upgraded += 1;
    acts.push(a.type === 'MOVE' ? `M(${a.x},${a.y})` : a.type);
  }
  if (turn === STOP) {
    // 画一张 ASCII 地图：城=C/水=~ 森林=f 丘陵=h，A 方单位 a，B 方单位 b
    const rows: string[] = [];
    for (let y = 0; y < s.h; y++) {
      let line = '';
      for (let x = 0; x < s.w; x++) {
        const t = s.tiles[y * s.w + x];
        const u = s.units.find((k) => k.x === x && k.y === y);
        if (u) line += u.owner === 'A' ? 'a' : 'b';
        else if (t?.terrain === 'water') line += '~';
        else if (t?.terrain === 'city') line += 'C';
        else if (t?.terrain === 'forest') line += 'f';
        else if (t?.terrain === 'hill') line += 'h';
        else line += '.';
      }
      rows.push(line);
    }
    console.log('\n地图：');
    rows.forEach((r, i) => console.log(String(i).padStart(2) + ' ' + r));
    console.log('    ' + Array.from({ length: s.w }, (_, i) => String(i % 10)).join(''));
    console.log(`\n回合 ${turn}（${side} 行动）动作序列：`);
    console.log('  ' + acts.join(' '));
    for (const p of ['A', 'B'] as const) {
      const enemyCity = citiesOf(s, p === 'A' ? 'B' : 'A')[0];
      console.log(`\n${p} 方单位：`);
      for (const u of unitsOf(s, p)) {
        const d = s.unitTypes[u.type];
        const dCity = enemyCity ? distToCity(u, enemyCity) : -1;
        const canHit = attackableTargets(s, u).length;
        const canSiege = siegeTargets(s, u).length;
        const reach = reachableTiles(s, u).size;
        const near = Math.min(...unitsOf(s, p === 'A' ? 'B' : 'A').map((e) => distance(u, e)), 99);
        console.log(
          `  ${u.type.padEnd(10)} (${String(u.x).padStart(2)},${String(u.y).padStart(2)})` +
            ` hp=${u.hp}/${d?.maxHp} 类别=${d?.category} 离敌城=${dCity}` +
            ` 最近敌=${near} 可动格=${reach} 可攻=${canHit} 可攻城=${canSiege}` +
            ` moved=${u.moved} acted=${u.acted}`,
        );
      }
    }
    break;
  }
  const e = applyAction(s, { type: 'END_TURN' });
  if (!e.ok) break;
  s = e.state;
}
