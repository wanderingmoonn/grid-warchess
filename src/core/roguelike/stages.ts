/**
 * 肉鸽的九场遭遇：**三幕 × 三场**（2026-11-19 扩写）。
 *
 * 结构（用户定的）：
 *   · 每幕前两场是**精英**——不给城，配置是「一只新设计的怪 + 一队常规怪」；
 *   · 每幕第三场是 **Boss**——**带城**，城里蹲一个被养肥的精英。
 *
 * 为什么 Boss 才给城：无城席位没有产线，清完就是空场；给它一座城，它才能
 * 持续出兵，玩家才得"顶着产线打"。精英不给城，是为了保住前两场
 * "清场 → 撤离"的快节奏。
 *
 * **森林只铺在上下边缘**（2026-11-19 踩过）：民兵移动力 2、进森林一格花 2，
 * 两格深的林带对它们就是一堵墙，敌人会卡在林前一动不动（用户实测 57 回合）。
 */

import type { LevelDef } from '../level.ts';
import './elites.ts';

export interface StageMeta {
  /** 幕（1 起） */
  act: number;
  /** 幕内第几场（1 起，3 = Boss） */
  slot: number;
  title: string;
  /** 敌人清空后给几手撤离时间 */
  evacTurns: number;
  /** 算"省下几手"的基准 */
  expectedTurns: number;
  /** 必掉的遗物 */
  relic?: string;
}

export interface SliceStage {
  level: LevelDef;
  meta: StageMeta;
}

const W = 16;
const H = 16;

function rowsOf(features: Array<[number, number, number]>): string[] {
  const grid = Array.from({ length: H }, () => Array.from({ length: W }, () => '.'));
  for (const [y, x0, x1] of features) for (let x = x0; x <= x1 && x < W; x += 1) grid[y]![x] = 'f';
  return grid.map((r) => r.join(''));
}

function stage(
  id: string,
  meta: StageMeta,
  opts: {
    name: string;
    brief: string;
    deploy: Array<{ type: string; x: number; y: number }>;
    /** Boss 关才给敌方的城 */
    enemyCity?: { x: number; y: number };
    forests: Array<[number, number, number]>;
  },
): SliceStage {
  const level: LevelDef = {
    id: `level:rogue-${id}`,
    version: 1,
    name: opts.name,
    brief: opts.brief,
    map: {
      id: `map:rogue-${id}`,
      name: opts.name,
      w: W,
      h: H,
      rows: rowsOf(opts.forests),
      citiesA: [{ x: 2, y: 3 }],
      citiesB: opts.enemyCity ? [opts.enemyCity] : [],
      source: 'user',
    },
    // 有城的 Boss 不再是无城席位：城没了它还能出兵，规则照旧
    seats: opts.enemyCity
      ? { count: 2, ai: ['B'] }
      : { count: 2, ai: ['B'], cityless: ['B'] },
    deploy: { B: opts.deploy },
    setup: {},
    /*
     * **无城席位必须声明 ai.pressure**（2026-11-19 的 bug）：
     * 否则 `aiNextActionCore` 返回空之后不会走 `pressureAdvance`，
     * AI 整回合空转，玩家看到的是"敌人一动不动"。
     */
    ai: { pressure: 1 },
  };
  return { level, meta };
}

/** 一队常规怪：随幕数加人 */
function squad(act: number, x: number): Array<{ type: string; x: number; y: number }> {
  // 和精英的站位错开：精英固定在 (9,6) / (11,8)，常规队走 11..13 的奇数列
  const bx = x + 2;
  const list = [
    { type: 'militia', x: bx, y: 5 },
    { type: 'militia', x: bx + 1, y: 7 },
    { type: 'archer', x: bx, y: 9 },
  ];
  if (act >= 2) list.push({ type: 'spearman', x: bx + 2, y: 6 });
  if (act >= 3) list.push({ type: 'crossbow', x: bx + 1, y: 11 });
  return list;
}

const FORESTS: Array<Array<[number, number, number]>> = [
  [
    [1, 5, 10],
    [2, 6, 11],
    [14, 5, 10],
  ],
  [
    [1, 4, 9],
    [13, 7, 12],
    [14, 6, 11],
  ],
  [
    [0, 6, 12],
    [1, 7, 13],
    [14, 6, 12],
    [15, 7, 13],
  ],
];

/** 每幕两场精英：一只新怪 + 常规队，无城 */
const ELITES: Array<{ id: string; name: string; brief: string; elite: string; relic?: string }> = [
  { id: 'a1e1', name: '林间遭遇', brief: '一个血盾兵领着两个散兵——打完记得把兵带回城。', elite: 'elite_shield' },
  { id: 'a1e2', name: '巡林队', brief: '钩镰手负责截你的后路。', elite: 'elite_hook', relic: 'packhorse' },
  { id: 'a2e1', name: '河湾伏击', brief: '它跑得比你的民兵快，别让它绕到城门口。', elite: 'elite_hook' },
  { id: 'a2e2', name: '焦土哨所', brief: '咒火术士把这片地烧黑了——别让它站成一线。', elite: 'elite_hexer' },
  { id: 'a3e1', name: '断桥', brief: '血盾兵堵桥，后面跟着长矛。', elite: 'elite_shield' },
  { id: 'a3e2', name: '灰烬林地', brief: '两个咒火术士。分散站位，别挤在一起。', elite: 'elite_hexer' },
];

/** 三幕的 Boss：带城 */
const BOSSES: Array<{ id: string; name: string; brief: string; elite: string; relic: string }> = [
  { id: 'a1b', name: '守门人', brief: '它守着一座小城——城不破，它就一直在出兵。', elite: 'elite_shield', relic: 'ironwall' },
  { id: 'a2b', name: '焚塔监工', brief: '城头一个咒火术士，城墙下一队工兵。', elite: 'elite_hexer', relic: 'arsenal' },
  { id: 'a3b', name: '钩镰首领', brief: '最后一战：它带城，也带着整支巡林队。', elite: 'elite_hook', relic: 'miser' },
];

function buildAll(): SliceStage[] {
  const out: SliceStage[] = [];
  for (let act = 1; act <= 3; act += 1) {
    const forests = FORESTS[act - 1]!;
    for (let i = 0; i < 2; i += 1) {
      const spec = ELITES[(act - 1) * 2 + i]!;
      const deploy = [{ type: spec.elite, x: 9, y: 6 }, ...squad(act, 9)];
      if (act === 3 && i === 1) deploy.push({ type: 'elite_hexer', x: 12, y: 9 });
      out.push(
        stage(
          spec.id,
          {
            act,
            slot: i + 1,
            title: spec.name,
            evacTurns: 2,
            expectedTurns: 6 + act,
            ...(spec.relic ? { relic: spec.relic } : {}),
          },
          { name: spec.name, brief: spec.brief, deploy, forests },
        ),
      );
    }
    const boss = BOSSES[act - 1]!;
    const deploy = [{ type: boss.elite, x: 11, y: 8 }, ...squad(act, 10)];
    if (act >= 2) deploy.push({ type: boss.elite, x: 13, y: 10 });
    out.push(
      stage(
        boss.id,
        {
          act,
          slot: 3,
          title: boss.name,
          // Boss 战要顶着城打，只给一手撤离等于「没法撤」——统一两回合
          evacTurns: 2,
          expectedTurns: 8 + act,
          relic: boss.relic,
        },
        {
          name: boss.name,
          brief: boss.brief,
          deploy,
          enemyCity: { x: 12, y: 7 },
          forests,
        },
      ),
    );
  }
  return out;
}

/** 九场：3 幕 × 3 场（精英 / 精英 / Boss） */
export const SLICE_STAGES: readonly SliceStage[] = buildAll();

export function stageAt(index: number): SliceStage {
  const i = Math.max(0, Math.min(SLICE_STAGES.length - 1, index));
  return SLICE_STAGES[i]!;
}

/** 面板上的一行：第 1 幕 · 第 2 场 */
export function actLabel(index: number): string {
  const m = stageAt(index).meta;
  return `第 ${m.act} 幕 · 第 ${m.slot} 场`;
}

/** Boss 关（结算文案、撤离手数会不一样） */
export function isBossStage(index: number): boolean {
  return stageAt(index).meta.slot === 3;
}
