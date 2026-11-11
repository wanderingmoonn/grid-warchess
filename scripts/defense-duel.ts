/**
 * 防御对决：**同造价**下，塔阵能不能挡住一波冲锋。
 *
 * ── 为什么要单独写一个 ────────────────────────────────────────────
 *
 * `balance-report` 跑的是标准 AI 对局：塔造得多不多、造在哪，全由 AI 的
 * 采购偏好决定。它回答的是"这套规则下塔被用得怎么样"，回答不了
 * "**同样一笔钱，守方占不占便宜**"——后者才是"建筑能不能保护经济区"的核心。
 *
 * 这里是纯脚本对局：棋盘铺平、去掉城市、两边兵力手工摆好，攻方按一条
 * 固定策略冲，守方只靠建筑自己开火（不手点）。所以同一份脚本在改前/改后
 * 两个版本上跑出来的差值，就是规则改动本身的差值。
 *
 * ── 为什么要用血量而不是伤害流水 ──────────────────────────────────
 *
 * 场景里只有塔会输出，所以"攻方掉了多少血"就等于"塔打了多少"。这样
 * 脚本不依赖任何统计钩子，改前那版（自动开火）也能原样跑。
 *
 * 用法：
 *   node --experimental-strip-types scripts/defense-duel.ts
 *   node --experimental-strip-types scripts/defense-duel.ts --matrix 2x0v4,3x0v5 --runs 20
 *   node --experimental-strip-types scripts/defense-duel.ts --unit sword --gap 9
 */

import { applyAction, distance, reachableTiles, utype } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState, PlayerId, Unit } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : dflt;
};

const UNIT = argOf('unit', 'militia');
const GAP = Number(argOf('gap', '7'));
const RUNS = Number(argOf('runs', '12'));
/** 守方除了塔之外还摆几个兵（护卫）。0 = 只有塔，纯测建筑本身 */
const GUARDS = Number(argOf('guards', '0'));
const GUARD_UNIT = argOf('guard-unit', 'militia');
const CAP = Number(argOf('cap', '24'));
const SIZE = Number(argOf('size', '20'));
/**
 * 阵型表：`塔x农v兵`。`1x2v3` = 1 座塔 + 2 个农民，对 3 个攻方。
 * 农民是"要保护的东西"——它不打人，只站在那里掉钱。
 */
const MATRIX = argOf('matrix', '1x0v2,2x0v4,3x0v5,1x2v3,2x2v4');
/**
 * 试算用的临时数值：`--thp 40 --tatk 14` 只改这一轮进程里的箭塔，
 * 不落盘。用来回答"补多少才够"，而不是先改表再验证。
 */
const THP = Number(argOf('thp', '0'));
const TATK = Number(argOf('tatk', '0'));

let seq = 0;
function put(s: GameState, owner: PlayerId, type: string, x: number, y: number): Unit {
  const def = s.unitTypes[type];
  const u: Unit = {
    id: `d${seq++}`,
    type,
    owner,
    x,
    y,
    hp: def.maxHp,
    kills: 0,
    moved: false,
    acted: false,
  };
  s.units.push(u);
  return u;
}

interface Row {
  label: string;
  runs: number;
  /** 攻方全灭的比例 */
  wipeAttacker: number;
  /** 守方塔全灭的比例 */
  wipeTower: number;
  /** 一个农民都没死的比例 */
  econSafe: number;
  /** 攻方平均活下来几个 */
  attackerAlive: number;
  /** 攻方总掉血 / 攻方满血（塔的输出） */
  attackerHurt: number;
  /** 守方总掉血 / 守方满血 */
  defenderHurt: number;
  /** 撑到第几回合才结束 */
  turns: number;
  /** 攻方身价损失 ÷ 守方身价损失 */
  valueRatio: number;
}

function priceOf(s: GameState, u: Unit): number {
  return s.unitTypes[u.type]?.cost ?? 0;
}

function runOne(
  towers: number,
  farmers: number,
  attackers: number,
  seed: number,
  guards = GUARDS,
): Omit<Row, 'label' | 'runs'> {
  seq = 0;
  const s0 = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: SIZE,
      startEra: 1,
      playerCount: 2,
      aiOpponent: false,
      aiAlly: false,
      expansionIds: [],
    } as never,
    seed,
  );
  s0.units = [];
  s0.winner = null;
  if (THP > 0) s0.unitTypes.tower = { ...s0.unitTypes.tower, maxHp: THP };
  if (TATK > 0) s0.unitTypes.tower = { ...s0.unitTypes.tower, atk: TATK };
  s0.log.length = 0;

  /*
   * **城市要留着。** 清掉它们看着更干净，但引擎会把"没有城"的席位当成
   * 已经出局：`END_TURN` 转一圈又回到同一个人，守方永远轮不到回合，
   * 新规则里的"回合开始清场"就一次也不会发生。
   * 所以改成"把战场挪到没有城的一条横带里"——城照旧在角落里吃灰。
   */
  const mid = Math.floor(SIZE / 2);
  let band = -1;
  for (let y0 = 0; y0 + 6 < SIZE; y0 += 1) {
    let clean = true;
    for (let y = y0; y <= y0 + 6 && clean; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        if (s0.tiles[y * SIZE + x]?.cityId) {
          clean = false;
          break;
        }
      }
    }
    if (clean) {
      band = y0;
      break;
    }
  }
  if (band < 0) band = 0;
  for (let y = band; y <= band + 6; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const t = s0.tiles[y * SIZE + x];
      if (t && !t.cityId) t.terrain = 'plain';
    }
  }

  const midY = band + 3;
  // 塔排成一条竖线，农民躲在塔后面（攻方从右边来）
  const tx = mid - 2;
  const top = midY - Math.floor(towers / 2);
  for (let i = 0; i < towers; i++) put(s0, 'A', 'tower', tx, top + i);
  for (let i = 0; i < farmers; i++) put(s0, 'A', 'farmer', tx - 2, top + i);
  // 护卫站在塔**前面**一格：他们的活是挡住冲进来的人，不是跟着农民躲
  for (let i = 0; i < guards; i++) put(s0, 'A', GUARD_UNIT, tx + 1, top + i);
  const ax = Math.min(SIZE - 1, tx + GAP);
  const atop = midY - Math.floor(attackers / 2);
  for (let i = 0; i < attackers; i++) put(s0, 'B', UNIT, ax, atop + i);

  const hp0 = {
    att: s0.units.filter((u) => u.owner === 'B').reduce((n, u) => n + u.hp, 0),
    def: s0.units.filter((u) => u.owner === 'A').reduce((n, u) => n + u.hp, 0),
    attValue: s0.units.filter((u) => u.owner === 'B').reduce((n, u) => n + priceOf(s0, u), 0),
    defValue: s0.units.filter((u) => u.owner === 'A').reduce((n, u) => n + priceOf(s0, u), 0),
  };

  let s = s0;
  let turn = 0;
  /** 攻方策略：走向最近的目标（农民优先，其次塔），走完能打就打 */
  const attackerAct = (): void => {
    const ids = s.units.filter((u) => u.owner === 'B').map((u) => u.id);
    for (const id of ids) {
      let u = s.units.find((k) => k.id === id);
      if (!u || u.hp <= 0) continue;
      const foes = s.units.filter((k) => k.owner === 'A' && k.hp > 0);
      if (foes.length === 0) return;
      const prey =
        foes.filter((k) => s.unitTypes[k.type]?.category === 'economy').sort((a, b) => distance(u!, a) - distance(u!, b))[0] ??
        foes.sort((a, b) => distance(u!, a) - distance(u!, b))[0]!;

      // 走一步：在所有可达格里挑"离目标最近"的那一格
      if (!u.moved) {
        const reach = reachableTiles(s, u);
        let best: { x: number; y: number } | null = null;
        let bestD = distance(u, prey);
        for (const i of reach.keys()) {
          const x = i % s.w;
          const y = Math.floor(i / s.w);
          if (x === u.x && y === u.y) continue;
          const d = Math.abs(x - prey.x) + Math.abs(y - prey.y);
          if (d < bestD) {
            bestD = d;
            best = { x, y };
          }
        }
        if (best) {
          const r = applyAction(s, { type: 'MOVE', unitId: u.id, x: best.x, y: best.y });
          if (r.ok) s = r.state;
          s.winner = null;
        }
        u = s.units.find((k) => k.id === id);
        if (!u) continue;
      }

      // 贴身就打
      const adjacent = s.units.find((k) => k.owner === 'A' && k.hp > 0 && distance(k, u!) <= 1);
      if (adjacent) {
        const r = applyAction(s, { type: 'ATTACK', unitId: u.id, targetId: adjacent.id });
        if (r.ok) s = r.state;
        s.winner = null;
      }
    }
  };

  const attackerCount = () => s.units.filter((u) => u.owner === 'B' && u.hp > 0).length;
  const towerCount = () => s.units.filter((u) => u.owner === 'A' && u.type === 'tower' && u.hp > 0).length;
  const farmerCount = () => s.units.filter((u) => u.owner === 'A' && u.hp > 0 && s.unitTypes[u.type]?.category === 'economy').length;

  /**
   * 守方回合：护卫只做一件事——**够得着就打**。
   *
   * 不让他们追出去：这条场景测的是"守不守得住"，护卫离阵去追人，
   * 阵型就散了，测出来的也不是建筑的价值。
   */
  const defenderAct = (): void => {
    const ids = s.units
      .filter((u) => u.owner === 'A' && u.hp > 0 && utype(s, u.type).category === 'combat')
      .map((u) => u.id);
    for (const id of ids) {
      const me = s.units.find((k) => k.id === id);
      if (!me || me.hp <= 0) continue;
      const prey = s.units.find((k) => k.owner === 'B' && k.hp > 0 && distance(k, me) <= 1);
      if (!prey) continue;
      const r = applyAction(s, { type: 'ATTACK', unitId: id, targetId: prey.id });
      if (r.ok) s = r.state;
      s.winner = null;
    }
  };

  /** 交回合；任何一步把对局判死了就清掉，脚本自己决定什么时候停 */
  const pass = (): boolean => {
    const r = applyAction(s, { type: 'END_TURN' });
    if (!r.ok) return false;
    s = r.state;
    s.winner = null;
    return true;
  };

  while (turn < CAP) {
    turn += 1;
    // 轮到攻方为止：守方回合什么都不做，但"进入守方回合"这件事本身会触发清场射击
    for (let guard = 0; s.current !== 'B' && guard < 6; guard += 1) {
      // 轮到守方：护卫先打（建筑物的清场射击在进入这个回合时已经结算过了）
      if (s.current === 'A') defenderAct();
      if (!pass()) break;
    }
    if (s.current !== 'B') break;

    attackerAct();
    if (attackerCount() === 0) break;
    if (!pass()) break;
    if (towerCount() === 0 && farmerCount() === 0) break;
  }

  const hp1 = {
    att: s.units.filter((u) => u.owner === 'B').reduce((n, u) => n + u.hp, 0),
    def: s.units.filter((u) => u.owner === 'A').reduce((n, u) => n + u.hp, 0),
    attValue: s.units.filter((u) => u.owner === 'B').reduce((n, u) => n + priceOf(s, u), 0),
    defValue: s.units.filter((u) => u.owner === 'A').reduce((n, u) => n + priceOf(s, u), 0),
  };

  return {
    wipeAttacker: attackerCount() === 0 ? 1 : 0,
    wipeTower: towers > 0 && towerCount() === 0 ? 1 : 0,
    econSafe: farmers > 0 && farmerCount() === farmers ? 1 : 0,
    attackerAlive: attackerCount(),
    attackerHurt: hp0.att > 0 ? (hp0.att - hp1.att) / hp0.att : 0,
    defenderHurt: hp0.def > 0 ? (hp0.def - hp1.def) / hp0.def : 0,
    turns: turn,
    valueRatio:
      hp0.defValue - hp1.defValue > 0
        ? (hp0.attValue - hp1.attValue) / (hp0.defValue - hp1.defValue)
        : Infinity,
  };
}

const rows: Row[] = [];
for (const spec of MATRIX.split(',')) {
  // `2x0v4` = 2 塔 0 农 vs 4 兵；`2x1g2v4` = 再多 2 个护卫
  const m = /^(\d+)x(\d+)(?:g(\d+))?v(\d+)$/.exec(spec.trim());
  if (!m) continue;
  const [towers, farmers, guards, attackers] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3] ?? 0),
    Number(m[4]),
  ];
  const acc: Row = {
    label: spec.trim(),
    runs: RUNS,
    wipeAttacker: 0,
    wipeTower: 0,
    econSafe: 0,
    attackerAlive: 0,
    attackerHurt: 0,
    defenderHurt: 0,
    turns: 0,
    valueRatio: 0,
  };
  let ratioSum = 0;
  let ratioN = 0;
  for (let i = 0; i < RUNS; i++) {
    const r = runOne(towers, farmers, attackers, 4300 + i, guards);
    acc.wipeAttacker += r.wipeAttacker;
    acc.wipeTower += r.wipeTower;
    acc.econSafe += r.econSafe;
    acc.attackerAlive += r.attackerAlive;
    acc.attackerHurt += r.attackerHurt;
    acc.defenderHurt += r.defenderHurt;
    acc.turns += r.turns;
    if (Number.isFinite(r.valueRatio)) {
      ratioSum += r.valueRatio;
      ratioN += 1;
    }
  }
  acc.wipeAttacker /= RUNS;
  acc.wipeTower /= RUNS;
  acc.econSafe /= RUNS;
  acc.attackerAlive /= RUNS;
  acc.attackerHurt /= RUNS;
  acc.defenderHurt /= RUNS;
  acc.turns /= RUNS;
  acc.valueRatio = ratioN > 0 ? ratioSum / ratioN : 0;
  rows.push(acc);
}

const pct = (n: number): string => `${Math.round(n * 100)}%`;
console.log(`防御对决：攻方 ${UNIT} ×N，塔阵 + 农民；间距 ${GAP} 格，每组 ${RUNS} 局\n`);
console.log('阵型      攻灭   塔灭   农民无损  攻方存活  攻方掉血  守方掉血  回合  交换比');
for (const r of rows) {
  console.log(
    `${r.label.padEnd(9)} ${pct(r.wipeAttacker).padStart(4)}  ${pct(r.wipeTower).padStart(4)}  ` +
      `${pct(r.econSafe).padStart(7)}  ${r.attackerAlive.toFixed(2).padStart(8)}  ` +
      `${pct(r.attackerHurt).padStart(7)}  ${pct(r.defenderHurt).padStart(7)}  ` +
      `${r.turns.toFixed(1).padStart(4)}  ${r.valueRatio.toFixed(2).padStart(5)}`,
  );
}
