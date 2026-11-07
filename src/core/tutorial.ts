/**
 * 新手教程的棋盘。
 *
 * 为什么单独造一局，而不是"让玩家自己开一局小的"：
 *   · 新手第一眼看到的必须是**能看懂的一局**——一张 12×12 的空板、两座城、
 *     三个兵。默认开局是 16×16、二十几个兵种、六个时代的选项，那不是教学，
 *     那是考试。
 *   · 教程要能**判定"他做到了"**。随机地图上算距离、找格子，判定会天天误判；
 *     钉死的坐标才有一句准话。
 *
 * 三个设计约束，都是踩过才写的：
 *   1. **B 席不接 AI。** `aiOpponent: false`，教程自己在 B 回合结束时替它按
 *      「结束回合」。接 AI 的话，那个农民会自己乱跑，"走到它旁边打一下"这一步
 *      随时可能扑空，而且 AI 还会拿钱造兵，把教学局走成真局。
 *   2. **地形全抹平**：森林/丘陵/水都会让"走两格"变成"走一格被挡"，
 *      新手第一课不该教地形。城市格保留。
 *   3. **每人只留一座城**。两人局默认两家各两座，教程里第二座城会让"破城即胜"
 *      变成"破两座城"，而且多余的城会把出口堵住。
 *
 * 坐标是写死的：A 城在左下 (2,7)，B 城在右上 (5,3)，玩家兵在 (3,7)，
 * 诱饵农民在 (4,5)。这样"移动一两步就能摸到城"，教程总长控制在 3 分钟。
 */
import { UNIT_TYPES } from './config.ts';
import { cityTiles, idx } from './rules.ts';
import { createMatch, DEFAULT_CONFIG } from './setup.ts';
import type { GameState } from './types.ts';

export const TUTORIAL_SEED = 20261107;
export const TUTORIAL_SIZE = 12;

/** 玩家在教程里指挥的兵（写得动，不写死"民兵"这种名字以外的依赖） */
export const MY_UNIT = 'militia';
/** 第一个攻击目标：对面一个不会还手的农民 */
export const BAIT_UNIT = 'farmer';

const MY_CITY = { x: 2, y: 7 };
const FOE_CITY = { x: 5, y: 3 };
const MY_UNIT_AT = { x: 3, y: 7 };
const BAIT_AT = { x: 4, y: 5 };

export function createTutorialMatch(): GameState {
  const s = createMatch(
    {
      ...DEFAULT_CONFIG,
      size: TUTORIAL_SIZE,
      startEra: 1,
      expansionIds: [],
      enabledUnits: Object.keys(UNIT_TYPES),
      // 双方都不交给 AI：B 席由教程代按「结束回合」，见文件头第 1 条
      aiOpponent: false,
      aiAlly: false,
      godMode: false,
    },
    TUTORIAL_SEED,
  );

  // ── 城市：只留两座，钉到固定坐标 ──
  for (const c of s.cities) {
    for (const t of cityTiles(c)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      if (!tile) continue;
      tile.cityId = null;
      if (tile.terrain === 'city') tile.terrain = 'plain';
    }
  }
  const mine = s.cities.filter((c) => c.owner === 'A')[0];
  const foe = s.cities.filter((c) => c.owner === 'B')[0];
  s.cities = [mine, foe].filter(Boolean) as typeof s.cities;

  const place = (c: (typeof s.cities)[number], at: { x: number; y: number }): void => {
    c.x = at.x;
    c.y = at.y;
    // 教程局的城墙要矮：一两次攻城就能破，不然新手会以为"打不动"
    c.hp = Math.min(c.hp, 18);
    c.maxHp = Math.min(c.maxHp, 18);
    for (const t of cityTiles(c)) {
      const tile = s.tiles[idx(s, t.x, t.y)];
      if (!tile) continue;
      tile.cityId = c.id;
      tile.terrain = 'city';
    }
  };
  place(mine!, MY_CITY);
  place(foe!, FOE_CITY);

  // ── 地形：只剩草地和两座城 ──
  for (const t of s.tiles) {
    if (t.terrain !== 'city') t.terrain = 'plain';
  }

  // ── 兵：玩家一个、对面一个诱饵 ──
  s.units = [];
  const spawn = (type: string, owner: 'A' | 'B', at: { x: number; y: number }, id: string): void => {
    const def = s.unitTypes[type];
    if (!def) return;
    s.units.push({
      id, type, owner, x: at.x, y: at.y,
      hp: def.maxHp, kills: 0, moved: false, acted: false,
    });
  };
  spawn(MY_UNIT, 'A', MY_UNIT_AT, 'tut-mine');
  spawn(BAIT_UNIT, 'B', BAIT_AT, 'tut-bait');

  // ── 局面状态：玩家先手、钱够不着造兵（教程不讲经济） ──
  s.current = 'A';
  s.turn = 1;
  s.winner = null;
  /*
   * 给玩家一笔钱：这一课要教"升级城市（220）"和"造兵（25 起）"。
   * 给 600 是留了余量——玩家完全可能挑个贵的兵，那之后还要升得起级。
   */
  s.players.A.gold = 600;
  s.players.B.gold = 0;
  s.log = [];
  return s;
}
