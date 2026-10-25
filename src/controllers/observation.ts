/** 外部控制器只接收显式公开的观察，不接收本地界面的 GameState 副本。 */
import { ABILITIES } from '../core/abilities.ts';
import { CONFIG } from '../core/config.ts';
import { activeExpansions } from '../core/expansions.ts';
import { idx, isHiddenFrom, recruitCost, upgradeCostOf, visibleTilesOf } from '../core/rules.ts';
import { productionOf } from '../core/rules/production.ts';
import type { City, GameState, KnownUnit, MatchWinner, PlayerId, Terrain, TurnProduction, Unit, UnitTypeDef } from '../core/types.ts';

export type ObservedUnitBase = Pick<Unit, 'id' | 'type' | 'owner' | 'x' | 'y' | 'hp' | 'kills' | 'moved' | 'acted'>;
export interface ObservedUnit extends ObservedUnitBase {
  /** 仅己方可见，货舱内容不递归展开。 */
  cargo?: ObservedUnitBase[];
}

export interface ControllerObservation {
  version: 1;
  player: PlayerId;
  turn: number;
  current: PlayerId;
  round: number;
  maxRounds: number;
  winner: MatchWinner;
  rules: {
    coordinates: string;
    turns: string;
    victory: string;
    production: string;
    movement: string;
    fog: boolean;
    commanderMode: boolean;
    commanderSlots: number;
    maxUnits: number;
    buildRange: number;
    expansionIds: string[];
    expansions: Array<{ id: string; name: string; summary: string }>;
    terrainCost: Record<Terrain, number>;
    terrainDefense: Record<Terrain, number>;
    counterAttackRatio: number;
    splashRatio: number;
    abilities: Array<{ id: string; name: string; summary: string }>;
  };
  self: {
    gold: number;
    production: TurnProduction;
    /** null 表示未设置计划；[] 表示显式留空的计划。 */
    orders: string[] | null;
    recruitCosts: Record<string, number>;
    upgradeCosts: Record<string, number | null>;
  };
  board: {
    width: number;
    height: number;
    /** 行优先，格索引 = y * width + x；地图地形公开。 */
    terrain: Terrain[];
    /** 当前可见格索引。关掉迷雾后为所有格。 */
    visible: number[];
  };
  cities: City[];
  units: ObservedUnit[];
  /** 仅本方过去看到的记录，不代表当前位置或仍然存活。 */
  ghosts: KnownUnit[];
  unitTypes: Record<string, UnitTypeDef>;
}

const TERRAINS: readonly Terrain[] = ['plain', 'forest', 'hill', 'water', 'mountain', 'bridge', 'city'];
const byId = <T extends { id: string }>(a: T, b: T): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

function copyTerrainTable(table: Record<Terrain, number>): Record<Terrain, number> {
  return Object.fromEntries(TERRAINS.map((terrain) => [terrain, table[terrain]])) as Record<Terrain, number>;
}

function copyUnit(unit: Unit): ObservedUnitBase {
  return {
    id: unit.id, type: unit.type, owner: unit.owner, x: unit.x, y: unit.y,
    hp: unit.hp, kills: unit.kills, moved: unit.moved, acted: unit.acted,
  };
}

function copyCity(city: City): City {
  const result: City = {
    id: city.id, owner: city.owner, x: city.x, y: city.y, size: city.size,
    era: city.era, hp: city.hp, maxHp: city.maxHp, armor: city.armor,
  };
  if (city.capturedTurn !== undefined) result.capturedTurn = city.capturedTurn;
  return result;
}

/** 定义表是公开规则，但其任意附加字段不是协议的一部分。 */
function copyType(def: UnitTypeDef): UnitTypeDef {
  const out: UnitTypeDef = {
    id: def.id, name: def.name, short: def.short, era: def.era, category: def.category,
    cost: def.cost, move: def.move, atk: def.atk, armor: def.armor, maxHp: def.maxHp,
    range: def.range, vision: def.vision,
  };
  for (const key of ['splash', 'burst', 'income', 'capacity'] as const) {
    if (def[key] !== undefined) out[key] = def[key];
  }
  for (const key of ['autoAttack', 'bridges', 'barracks', 'transport', 'requiresWater'] as const) {
    if (def[key] !== undefined) out[key] = def[key];
  }
  if (def.domain !== undefined) out.domain = def.domain;
  if (def.builds !== undefined) out.builds = [...def.builds];
  if (def.abilities !== undefined) out.abilities = [...def.abilities];
  if (def.buildOn !== undefined) out.buildOn = [...def.buildOn];
  if (def.incomeByTerrain !== undefined) {
    out.incomeByTerrain = {};
    for (const terrain of TERRAINS) {
      const income = def.incomeByTerrain[terrain];
      if (income !== undefined) out.incomeByTerrain[terrain] = income;
    }
  }
  return out;
}

/**
 * 输入应为通过存档边界校验的有效对局。这里只允许当前操控者请求观察；
 * 胜负已定时也允许读取最终观察。所有嵌套对象均重新构造，调用方可安全序列化。
 */
export function observeGame(state: GameState, player: PlayerId): ControllerObservation {
  if (player !== state.current) throw new Error('只能请求当前行动方的控制器观察');
  const visible = state.fog
    ? [...visibleTilesOf(state, player)].sort((a, b) => a - b)
    : Array.from({ length: state.w * state.h }, (_, i) => i);
  const visibleSet = new Set(visible);
  const visibleUnits = state.units.filter((unit) => unit.owner === player || !state.fog
    || (visibleSet.has(idx(state, unit.x, unit.y)) && !isHiddenFrom(state, unit, player)));
  const seenIds = new Set(visibleUnits.map((unit) => unit.id));
  const units: ObservedUnit[] = visibleUnits.map((unit) => {
    const out: ObservedUnit = copyUnit(unit);
    if (unit.owner === player && unit.cargo !== undefined) out.cargo = unit.cargo.map(copyUnit).sort(byId);
    return out;
  }).sort(byId);
  const ledger = productionOf(state);
  const production: TurnProduction = {
    turn: ledger.turn, player: ledger.player, recruited: ledger.recruited, upgraded: ledger.upgraded,
  };
  if (ledger.legacyLocked !== undefined) production.legacyLocked = ledger.legacyLocked;
  const types = Object.values(state.unitTypes).sort(byId);
  const commanderMode = state.config.commanderMode === true;

  return {
    version: 1, player, turn: state.turn, current: state.current,
    round: Math.ceil(state.turn / 2), maxRounds: CONFIG.maxRounds, winner: state.winner,
    rules: {
      coordinates: '坐标从 0 开始；x 向右、y 向下；格索引 = y * width + x。',
      turns: 'turn 是单方行动序号；A、B 各行动一次为一完整轮。END_TURN 结束当前方行动。',
      victory: `失去全部城市判负；双方都无城为平局；第 ${CONFIG.maxRounds} 完整轮在 B 结束行动后按城市数量裁决，多者获胜、同数平局。`,
      production: commanderMode
        ? '全城和军营每方每回合共享一次招募或升级额度；成功才消耗。建筑使用建造者行动。orders 为 null 时可自主生产，空队首禁止生产，兵种队首仅允许对应招募，@upgrade 仅允许升级；结束回合计划前移。'
        : '普通模式没有全军共享的一次生产限制，受金币、时代、编制与产出位置约束；建筑使用建造者行动。',
      movement: '每单位每回合最多移动一次和攻击一次；四向移动、曼哈顿射程，移动先于或后于攻击均可。陆军不能走水和高山，水军沿水面和桥通行；未知敌军可能使行动失败。',
      fog: state.fog, commanderMode, commanderSlots: CONFIG.commanderSlots,
      maxUnits: CONFIG.maxUnits, buildRange: CONFIG.buildRange,
      expansionIds: [...state.config.expansionIds],
      expansions: activeExpansions(state).map((expansion) => ({
        id: expansion.id, name: expansion.name, summary: expansion.summary,
      })),
      terrainCost: copyTerrainTable(CONFIG.terrainCost),
      terrainDefense: copyTerrainTable(CONFIG.terrainDef),
      counterAttackRatio: CONFIG.counterAttackRatio, splashRatio: CONFIG.splashRatio,
      abilities: ABILITIES.map((ability) => ({ id: ability.id, name: ability.name, summary: ability.summary })),
    },
    self: {
      gold: state.players[player].gold, production,
      orders: Object.hasOwn(state.orders ?? {}, player) ? [...(state.orders?.[player] ?? [])] : null,
      recruitCosts: Object.fromEntries(types.map((type) => [type.id, recruitCost(state, player, type)])),
      upgradeCosts: Object.fromEntries(state.cities.filter((city) => city.owner === player)
        .sort(byId).map((city) => [city.id, upgradeCostOf(state, city)])),
    },
    board: { width: state.w, height: state.h, terrain: state.tiles.map((tile) => tile.terrain), visible },
    cities: state.cities.map(copyCity).sort(byId),
    units,
    ghosts: state.fog ? state.memory[player].known.filter((known) => !seenIds.has(known.id)).map((known) => ({
      id: known.id, type: known.type, x: known.x, y: known.y, seenAt: known.seenAt,
    })).sort(byId) : [],
    unitTypes: Object.fromEntries(types.map((type) => [type.id, copyType(type)])),
  };
}
