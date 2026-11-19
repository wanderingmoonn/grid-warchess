/**
 * 肉鸽切片 · 三场手写遭遇。
 *
 * 全部是普通 `LevelDef`：能被关卡编辑器打开、能被审核台预览、能被云端分享。
 * 这样"肉鸽内容"和"关卡内容"共用同一条生产管线，作者不用学两套东西。
 *
 * 敌人一律是无城席位（`seats.cityless`）：兵打光就输，正好表达"一支小队"；
 * 玩家则是普通带城席位（城市 = 兵额 = 撤离点）。
 */

import type { LevelDef } from '../level.ts';

/** 一关的肉鸽元数据：撤离手数、期望手数、守门人掉落的遗物 */
export interface StageMeta {
  /** 敌人清空后给几手撤离时间 */
  evacTurns: number;
  /** 用来算"省下几手"的基准 */
  expectedTurns: number;
  /** 必掉的遗物（强力敌人 / 守门人） */
  relic?: string;
  /** 给界面显示的名字 */
  title: string;
}

export interface SliceStage {
  level: LevelDef;
  meta: StageMeta;
}

/** 16×16 空地，指定行插入一点地形，避免每张图都长一样 */
function rows(w: number, h: number, patch: Array<[number, number, number]> = []): string[] {
  const grid = Array.from({ length: h }, () => Array.from({ length: w }, () => '.'));
  for (const [y, from, to] of patch) {
    for (let x = from; x <= to && x < w; x += 1) grid[y]![x] = 'f';
  }
  return grid.map((line) => line.join(''));
}

const MAP_META = { w: 16, h: 16 };

/** 第 1 关：一支过路的小队，教你"打完要回城" */
const S1: SliceStage = {
  meta: { title: '林间遭遇', evacTurns: 2, expectedTurns: 6 },
  level: {
    id: 'level:rogue-s1',
    version: 1,
    name: '林间遭遇',
    brief: '肉鸽第 1 关：三个散兵，打完记得把兵带回城。',
    map: {
      id: 'map:rogue-s1',
      name: '林间空地',
      ...MAP_META,
      rows: rows(MAP_META.w, MAP_META.h, [
        [1, 5, 10],
        [2, 6, 11],
        [14, 5, 10],
      ]),
      citiesA: [{ x: 2, y: 3 }],
      citiesB: [],
      source: 'user',
    },
    seats: { count: 2, ai: ['B'], cityless: ['B'] },
    deploy: {
      B: [
        { type: 'militia', x: 9, y: 6 },
        { type: 'militia', x: 10, y: 8 },
        { type: 'archer', x: 9, y: 10 },
      ],
    },
    setup: {},
  },
};

/** 第 2 关：多一个远程 + 一个骑士，逼你算"要不要冲上去换" */
const S2: SliceStage = {
  meta: { title: '巡林队', evacTurns: 2, expectedTurns: 7 },
  level: {
    id: 'level:rogue-s2',
    version: 1,
    name: '巡林队',
    brief: '肉鸽第 2 关：有一个骑士，别让他冲进你的城。',
    map: {
      id: 'map:rogue-s2',
      name: '林道',
      ...MAP_META,
      rows: rows(MAP_META.w, MAP_META.h, [
        [1, 6, 12],
        [2, 7, 13],
        [13, 6, 12],
        [14, 7, 13],
      ]),
      citiesA: [{ x: 2, y: 6 }],
      citiesB: [],
      source: 'user',
    },
    seats: { count: 2, ai: ['B'], cityless: ['B'] },
    deploy: {
      B: [
        { type: 'knight', x: 10, y: 7 },
        { type: 'militia', x: 9, y: 6 },
        { type: 'militia', x: 10, y: 9 },
        { type: 'archer', x: 9, y: 11 },
      ],
    },
    setup: {},
  },
};

/** 第 3 关：守门人，携带固定遗物（打赢必得） */
const S3: SliceStage = {
  meta: { title: '守门人', evacTurns: 2, expectedTurns: 8, relic: 'tower' },
  level: {
    id: 'level:rogue-s3',
    version: 1,
    name: '守门人',
    brief: '肉鸽第 3 关：他守着【瞭望】，打掉他就能带走。',
    map: {
      id: 'map:rogue-s3',
      name: '关隘',
      ...MAP_META,
      rows: rows(MAP_META.w, MAP_META.h, [
        [0, 6, 12],
        [1, 7, 13],
        [14, 6, 12],
        [15, 7, 13],
      ]),
      citiesA: [{ x: 2, y: 7 }],
      citiesB: [],
      source: 'user',
    },
    seats: { count: 2, ai: ['B'], cityless: ['B'] },
    deploy: {
      B: [
        { type: 'knight', x: 11, y: 8 },
        { type: 'longbow', x: 10, y: 7 },
        { type: 'longbow', x: 10, y: 9 },
        { type: 'militia', x: 9, y: 8 },
        { type: 'archer', x: 8, y: 10 },
      ],
    },
    setup: {},
  },
};

/** 切片就这三关。顺序有意义：难度和"该学的东西"逐关递进。 */
export const SLICE_STAGES: readonly SliceStage[] = [S1, S2, S3];

/** 第 n 个节点（0 起）；越界返回最后一关，方便"打不到头"的调试 */
export function stageAt(index: number): SliceStage {
  return SLICE_STAGES[Math.min(Math.max(0, index), SLICE_STAGES.length - 1)]!;
}
