/**
 * 平衡消融实验（ablation）。
 *
 * 用来回答「某个数字到底是哪个改动顶上去的」：
 * 在同一批种子上，逐个把某一轮平衡改动"撤销"，看指标回到多少。
 *
 * 所有开关都在运行时改 CONFIG / ERAS / UNIT_TYPES 这三个导出对象，
 * 不动源码，跑完自动还原。
 *
 * 运行：npm run ablate          （AB_SEEDS / AB_ERA / AB_SIZE 可调）
 */

import { AI_MAX_STEPS, aiNextAction } from '../src/core/ai.ts';
import { CONFIG, ERAS, UNIT_TYPES } from '../src/core/config.ts';
import { applyAction } from '../src/core/rules.ts';
import { createMatch, DEFAULT_CONFIG } from '../src/core/setup.ts';
import type { GameState } from '../src/core/types.ts';

const SEEDS = Number(process.env.AB_SEEDS ?? 60);
const CAP = Number(process.env.AB_CAP ?? 180);
const ERA = Number(process.env.AB_ERA ?? 1);
const SIZE = Number(process.env.AB_SIZE ?? 12);

/** 把 UNIT_TYPES 拍个快照，实验之间还原 */
const SNAP_UNITS = JSON.parse(JSON.stringify(UNIT_TYPES)) as typeof UNIT_TYPES;
const SNAP_ERAS = JSON.parse(JSON.stringify(ERAS)) as typeof ERAS;
const SNAP_REGEN = { ...CONFIG };

function restoreUnits(): void {
  for (const k of Object.keys(SNAP_UNITS)) {
    Object.assign(UNIT_TYPES[k]!, SNAP_UNITS[k]!);
  }
}
function restoreEras(): void {
  ERAS.forEach((e, i) => Object.assign(e, SNAP_ERAS[i]!));
}
function restoreAll(): void {
  restoreUnits();
  restoreEras();
  Object.assign(CONFIG, SNAP_REGEN);
}

/** 两侧城市之间的最近距离（以左上角格计，曼哈顿） */
function cityGap(s: GameState): number {
  const a = s.cities.filter((c) => c.owner === 'A');
  const b = s.cities.filter((c) => c.owner === 'B');
  let best = Infinity;
  for (const ca of a) for (const cb of b) {
    best = Math.min(best, Math.abs(ca.x - cb.x) + Math.abs(ca.y - cb.y));
  }
  return best === Infinity ? 0 : best;
}

function waterTiles(s: GameState): number {
  return s.tiles.filter((t) => t.terrain === 'water').length;
}

interface One {
  turns: number;
  decided: boolean;
  maxEra: number;
  gap: number;
  water: number;
  /** 第一次有人动手（ATTACK / SIEGE）的回合 */
  firstBlood: number;
  /** 第一次有人升级时代的回合 */
  firstUpgrade: number;
  /** 结束时的平均城市等级 */
  endEra: number;
}

function playOne(seed: number): One {
  let s: GameState = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: SIZE,
      startEra: ERA,
      aiOpponent: true,
      aiAlly: true,
      enabledUnits: Object.keys(UNIT_TYPES),
    },
    seed,
  );
  const gap = cityGap(s);
  const water = waterTiles(s);

  const budget = { maxRecruit: 2, maxUpgrade: 1, recruited: 0, upgraded: 0 };
  let turns = 0;
  let firstBlood = 0;
  let firstUpgrade = 0;
  for (let t = 0; t < CAP; t++) {
    budget.recruited = 0;
    budget.upgraded = 0;
    turns += 1;
    for (let step = 0; step < AI_MAX_STEPS * 2; step++) {
      const a = aiNextAction(s, budget);
      if (!a) break;
      if (!firstBlood && (a.type === 'ATTACK' || a.type === 'SIEGE')) firstBlood = turns;
      if (!firstUpgrade && a.type === 'UPGRADE') firstUpgrade = turns;
      if (a.type === 'RECRUIT') budget.recruited += 1;
      if (a.type === 'UPGRADE') budget.upgraded += 1;
      const r = applyAction(s, a);
      if (!r.ok) break;
      s = r.state;
    }
    if (s.winner) break;
    const end = applyAction(s, { type: 'END_TURN' });
    if (!end.ok) break;
    s = end.state;
    if (s.winner) break;
  }
  const eras = s.cities.map((c) => c.era);
  return {
    turns,
    decided: !!s.winner,
    maxEra: Math.max(...eras, 0),
    gap,
    water,
    firstBlood: firstBlood || turns,
    firstUpgrade: firstUpgrade || turns,
    endEra: avg(eras),
  };
}

function seedFor(i: number): number {
  // 与 bench.ts 保持一致，保证两次跑的是同一批图
  return 20260000 + i * 7919 + SIZE * 31 + ERA;
}

const avg = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

interface Variant {
  name: string;
  apply: () => void;
}

const VARIANTS: Variant[] = [
  { name: '当前版本', apply: () => {} },
  {
    name: '撤销·城市回血',
    apply: () => {
      CONFIG.cityRegen = 0;
      CONFIG.cityRegenPerExtra = 0;
      CONFIG.cityRegenCap = 0;
    },
  },
  {
    name: '撤销·机动视野削减',
    apply: () => {
      for (const u of Object.values(UNIT_TYPES)) {
        if (u.move >= 2) u.move += 1;
        u.vision += 1;
      }
    },
  },
  {
    name: '撤销·升级涨价',
    apply: () => {
      const old = [0, 120, 200, 320, 460];
      ERAS.forEach((e, i) => {
        e.upgradeCost = old[i] ?? e.upgradeCost;
      });
    },
  },
  {
    name: '撤销·射程回调',
    apply: () => {
      // 第 19 轮把远程射程补回来之前：弓手 2 / 长弓 3 / 火枪 2 / 步枪 2 / 机枪 2 / 步兵班 2
      const old: Record<string, number> = {
        archer: 2,
        longbow: 3,
        musketeer: 2,
        rifleman: 2,
        mg: 2,
        hmg: 2,
        squad: 2,
        mortar: 2,
        artillery: 3,
        tank: 1,
        armoredcar: 1,
        ironclad: 3,
      };
      for (const [id, r] of Object.entries(old)) {
        const u = UNIT_TYPES[id];
        if (u) u.range = r;
      }
    },
  },
  {
    name: '全部撤销（近似旧版）',
    apply: () => {
      CONFIG.cityRegen = 0;
      CONFIG.cityRegenPerExtra = 0;
      CONFIG.cityRegenCap = 0;
      for (const u of Object.values(UNIT_TYPES)) {
        if (u.move >= 2) u.move += 1;
        u.vision += 1;
      }
      const old = [0, 120, 200, 320, 460];
      ERAS.forEach((e, i) => {
        e.upgradeCost = old[i] ?? e.upgradeCost;
      });
      const oldRange: Record<string, number> = {
        archer: 2, longbow: 3, musketeer: 2, rifleman: 2, mg: 2, hmg: 2,
        squad: 2, mortar: 2, artillery: 3, tank: 1, armoredcar: 1, ironclad: 3,
      };
      for (const [id, r] of Object.entries(oldRange)) {
        const u = UNIT_TYPES[id];
        if (u) u.range = r;
      }
    },
  },
];

console.log(`起始时代 E${ERA} · ${SIZE}×${SIZE} · ${SEEDS} 个种子 · 回合上限 ${CAP}\n`);
console.log('变体                  完成   平均回合  中位  最高时代  首次交战  首次升级  升级后剩余');

const baseline: One[] = [];
const detail = new Map<string, One[]>();
for (const v of VARIANTS) {
  restoreAll();
  v.apply();
  const rs: One[] = [];
  for (let i = 0; i < SEEDS; i++) rs.push(playOne(seedFor(i)));
  if (v.name === '当前版本') baseline.push(...rs);
  detail.set(v.name, rs);

  const sorted = [...rs.map((x) => x.turns)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(
    `${v.name.padEnd(22)}${String(rs.filter((x) => x.decided).length).padStart(2)}/${SEEDS}` +
      `${avg(rs.map((x) => x.turns)).toFixed(0).padStart(9)}${String(median).padStart(6)}` +
      `${avg(rs.map((x) => x.maxEra)).toFixed(1).padStart(9)}` +
      `${avg(rs.map((x) => x.firstBlood)).toFixed(0).padStart(10)}` +
      `${avg(rs.map((x) => x.firstUpgrade)).toFixed(0).padStart(10)}` +
      `${(avg(rs.map((x) => x.turns)) - avg(rs.map((x) => x.firstUpgrade))).toFixed(0).padStart(11)}`,
  );
}
restoreAll();

// ---------------------------------------------------------------
// 城市间距到底有多大影响：按"两军城市最近距离"分组看回合数
// ---------------------------------------------------------------
console.log('\n城市间距分布（当前版本同一批种子）');
const byGap = new Map<number, One[]>();
for (const o of baseline) {
  const k = o.gap;
  if (!byGap.has(k)) byGap.set(k, []);
  byGap.get(k)!.push(o);
}
for (const [g, group] of [...byGap.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(
    `  最近距离 ${String(g).padStart(2)} 格：${String(group.length).padStart(3)} 局` +
      `   平均回合 ${avg(group.map((x) => x.turns)).toFixed(0).padStart(4)}` +
      `   平均最高时代 ${avg(group.map((x) => x.maxEra)).toFixed(1)}`,
  );
}
console.log(
  `  间距范围 ${Math.min(...baseline.map((x) => x.gap))} ~ ${Math.max(...baseline.map((x) => x.gap))} 格` +
    `（平均 ${avg(baseline.map((x) => x.gap)).toFixed(1)}），水域平均 ${avg(baseline.map((x) => x.water)).toFixed(0)} 格`,
);

// ---------------------------------------------------------------
// 「时代到底是原因还是结果」：把当前版本按最终最高时代分组
// ---------------------------------------------------------------
console.log('\n按最终最高时代分组（当前版本）');
const byEraG = new Map<number, One[]>();
for (const o of baseline) {
  if (!byEraG.has(o.maxEra)) byEraG.set(o.maxEra, []);
  byEraG.get(o.maxEra)!.push(o);
}
for (const [e, group] of [...byEraG.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(
    `  最高 E${e}：${String(group.length).padStart(3)} 局` +
      `   平均回合 ${avg(group.map((x) => x.turns)).toFixed(0).padStart(4)}` +
      `   首次交战 ${avg(group.map((x) => x.firstBlood)).toFixed(0).padStart(4)}` +
      `   首次升级 ${avg(group.map((x) => x.firstUpgrade)).toFixed(0).padStart(4)}` +
      `   两军间距 ${avg(group.map((x) => x.gap)).toFixed(1)}`,
  );
}

// ---------------------------------------------------------------
// 杀伤效率：攻击的成长是不是快过血甲的成长
// ---------------------------------------------------------------
console.log('\n各代战斗单位均值与「击杀所需命中数」（同代对打）');
for (let e = 1; e <= 5; e++) {
  const us = Object.values(UNIT_TYPES).filter(
    (u) => u.era === e && u.category === 'combat' && !u.transport,
  );
  if (us.length === 0) continue;
  const atk = avg(us.map((u) => (u.atk ?? 0) * (u.burst ?? 1)));
  const armor = avg(us.map((u) => u.armor ?? 0));
  const hp = avg(us.map((u) => u.maxHp ?? 0));
  const hits = hp / Math.max(1, atk - armor);
  console.log(
    `  E${e}  攻击 ${atk.toFixed(0).padStart(3)}（含连击）  护甲 ${armor.toFixed(1)}` +
      `  血量 ${hp.toFixed(0).padStart(3)}   →  需要 ${hits.toFixed(1)} 次命中`,
  );
}
