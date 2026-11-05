/**
 * 一次性诊断：老师给的 MOVE 为什么不在 legalActions 的 MOVE 里。
 *
 * 只跑一局、只在进程内，不碰 worker。打印前 12 个不匹配的细节：
 * 单位、老师的目标格、该格上有什么、距离、reachableTiles 里有没有它。
 */
import { AI_MAX_STEPS, DEFAULT_BUDGET, aiNextAction } from '../../src/core/ai.ts';
import { applyAction, reachableTiles, tileAt, unitAt, utype } from '../../src/core/rules.ts';
import { DEFAULT_CONFIG, createMatch } from '../../src/core/setup.ts';
import type { GameState } from '../../src/core/types.ts';
import { legalActions } from './legal.ts';

const seed = Number(process.argv[2] ?? 12000);
let s: GameState = createMatch(
  { ...DEFAULT_CONFIG, size: 10, startEra: 1, playerCount: 2, draftMode: false, aiOpponent: false, aiAlly: false, expansionIds: ['bloodbath'], aiLevel: 'advanced' },
  seed,
);
s.fog = false;

let turnSeat: string | null = null;
let budget = { ...DEFAULT_BUDGET };
let rejected = new Set<string>();
let inTurn = 0;
let shown = 0;

while (!s.winner && s.turn <= 150) {
  const seat = s.current;
  if (seat !== turnSeat) {
    turnSeat = seat;
    inTurn = 0;
    budget = { ...DEFAULT_BUDGET };
    rejected = new Set();
  }
  if (inTurn >= AI_MAX_STEPS) {
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    inTurn += 1;
    continue;
  }
  const picked = aiNextAction(s, budget, rejected);
  if (!picked) {
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    inTurn += 1;
    continue;
  }
  if (picked.type === 'RECRUIT') budget.recruited += 1;
  if (picked.type === 'UPGRADE') budget.upgraded += 1;

  const acts = legalActions(s, seat);
  const hit = acts.some(
    (a) =>
      a.type === picked.type &&
      (!('unitId' in a) || !('unitId' in picked) || a.unitId === picked.unitId) &&
      (!('x' in a) || !('x' in picked) || (a.x === picked.x && a.y === picked.y)),
  );
  if (!hit && shown < 12) {
    shown += 1;
    const u = 'unitId' in picked ? s.units.find((x) => x.id === picked.unitId) : undefined;
    const line: string[] = [`[${shown}] 第 ${s.turn} 回合 · ${picked.type} ${JSON.stringify(picked)}`];
    if (u && picked.type === 'MOVE') {
      const key = picked.y * s.w + picked.x;
      const reach = reachableTiles(s, u);
      line.push(
        `    单位 ${u.id}(${u.type}) 在 (${u.x},${u.y}) moved=${u.moved} 目标 (${picked.x},${picked.y})`,
        `    reachable 里有？${reach.has(key)} 距离=${Math.max(Math.abs(u.x - picked.x), Math.abs(u.y - picked.y))}`,
        `    目标地形=${tileAt(s, picked.x, picked.y)?.terrain} 有人？${unitAt(s, picked.x, picked.y)?.id ?? '无'}`,
        `    预算 move=${utype(s, u.type).move} reach 可达格数=${reach.size}`,
      );
    }
    console.log(line.join('\n'));
  }

  const r = applyAction(s, picked);
  if (!r.ok) {
    rejected.add(JSON.stringify(picked));
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    inTurn += 1;
    continue;
  }
  s = r.state;
  inTurn += 1;
}
console.log('结束：', s.winner, '回合', s.turn);
