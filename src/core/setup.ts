/**
 * 开局：把一份对局配置变成一局具体的游戏。
 *
 * 配置里只有"选了什么"（棋盘多大、开哪些扩展、用哪些兵种），
 * 地形和部署由 seed 决定性地生成出来。
 * 同一个 (config, seed) 永远得到完全一样的一局，回放和联机才有意义。
 */

import { CITY, CONFIG, ERAS, UNIT_TYPES, eraDef, passable } from './config.ts';
import { EXPANSIONS, activeExpansions, expansionById } from './expansions.ts';
import { generateLayout } from './mapgen.ts';
import { refreshMemory, grantOpeningIncome } from './rules.ts';
import type { City, GameState, MatchConfig, PlayerId, Terrain, Tile, Unit, UnitTypeDef } from './types.ts';

const CHAR_TO_TERRAIN: Record<string, Terrain> = {
  '.': 'plain',
  f: 'forest',
  h: 'hill',
  '~': 'water',
  '^': 'mountain',
};

/** 开局界面里可选的棋盘尺寸 */
export const BOARD_SIZES = [12, 16, 20];

/**
 * 标准对局的默认组合：古典时代 + 12×12。
 *
 * 时代和尺寸是配套的（古典 12×12 / 中世 16×16 / 火药及以后 20×20）：
 * 古典兵走得慢、打得近，图大了两边要磨十个回合才照面；
 * 现代图小了又摆不开坦克和火炮。开局面板选时代时会自动换成对应尺寸。
 */
export const DEFAULT_CONFIG: MatchConfig = {
  size: 12,
  startEra: 1,
  aiOpponent: false,
  aiAlly: false,
  aiLevel: 'advanced',
  mapStyle: 'random',
  mapSymmetry: 'fair',
  // 血战默认开：第 50 回合起城市不再回血、升级回原价、全军移动视野各 +1。
  // 关着它跑出来的对局，后半段全在互相推不动的拉锯里耗到回合上限
  // （实测未决率 5.8%→0.8%、中世 17.5%→10.0%，平均少打 15~19 回合）。
  // 想玩回老节奏，在新对局面板里把它取消勾选就行。
  //
  // 先后手补偿默认开：后手开局多拿一笔起始金（12×12 补 20%、16×16 补 5%）。
  // 双 AI 对轰 720 局测出来的：不补的话先手在 12×12 能赢到 66.7%、16×16 63.0%，
  // 补完之后落到 60.0% / 50.9%。这是目前唯一一个真正把先手优势压下来的规则
  // （+5%/+20% 起始金、削首回合收入那几条都试过，只有它稳）。
  expansionIds: ['bloodbath', 'turn-order-comp'],
  enabledUnits: Object.keys(UNIT_TYPES),
};

/** 起始时代越高，开局金币也要跟上，否则高级城造不起高级兵 */
/**
 * 开局金币随起始时代一起涨。
 *
 * 一万个理由：时代越高，兵越贵（民兵 25、坦克 380）。如果开局金币还是 120，
 * 从现代开局的第一回合你连一个兵都造不出来，只能干等收入——那不叫"快节奏开局"，
 * 那叫"开局罚站"。
 *
 * 每级 +240 是按"买得起差不多数量的兵"定的：120 能买 4~5 个民兵，
 * 1080 差不多能买 3 个现代兵，量级对得上。
 */
export function startGoldFor(startEra: number): number {
  return CONFIG.startGold + (startEra - 1) * 240;
}

export function createMatch(
  config: MatchConfig,
  seed: number,
  customUnits: Record<string, UnitTypeDef> = {},
): GameState {
  // 先合并：内置兵种 + 玩家自定义 + 已启用扩展自带的兵种
  const extraUnits: Record<string, UnitTypeDef> = { ...customUnits };
  for (const id of config.expansionIds) {
    for (const u of expansionById(id)?.units ?? []) extraUnits[u.id] = { ...u };
  }
  const catalog: Record<string, UnitTypeDef> = { ...UNIT_TYPES, ...extraUnits };

  const enabled = config.enabledUnits.filter((id) => catalog[id]);
  const pool = enabled.length > 0 ? enabled : Object.keys(UNIT_TYPES);
  // 勾了某个扩展，它带的兵种就默认进场，不用再单独勾
  for (const id of Object.keys(extraUnits)) {
    if (!pool.includes(id)) pool.push(id);
  }

  // 开局部队只给时代 1 的**陆军**战斗单位：
  // 高级兵靠城市升级，水军要临水城市自己造，经济单位和建筑同理。
  const startingPool = pool.filter((id) => {
    const d = catalog[id];
    return d?.era === 1 && d.category === 'combat' && d.domain !== 'water';
  });
  // 出生点只能用陆军：把水军从候选里剔掉，否则船会被摆在陆地上
  const spawnPool = (startingPool.length > 0 ? startingPool : pool).filter(
    (id) => catalog[id]?.domain !== 'water',
  );
  const layout = generateLayout(
    config.size,
    seed,
    spawnPool,
    { style: config.mapStyle ?? 'random', symmetry: config.mapSymmetry ?? 'fair' },
  );
  const w = layout.w;
  const h = layout.h;

  // ---- 地形 ----
  const tiles: Tile[] = [];
  for (let y = 0; y < h; y++) {
    const row = layout.rows[y] ?? '';
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '.';
      tiles.push({ terrain: CHAR_TO_TERRAIN[ch] ?? 'plain', cityId: null });
    }
  }

  // ---- 本局实际使用的兵种表 ----
  const unitTypes: Record<string, UnitTypeDef> = {};
  for (const id of pool) {
    const def = catalog[id];
    if (def) unitTypes[id] = { ...def };
  }

  // ---- 城市 ----
  const cities: City[] = [];
  let citySeq = 1;
  const startEra = Math.max(1, Math.min(ERAS.length, config.startEra));
  const eraInfo = eraDef(startEra);

  const placeCity = (owner: PlayerId, left: number, top: number) => {
    const id = `c${citySeq++}`;
    cities.push({
      id,
      x: left,
      y: top,
      size: CITY.size,
      owner,
      era: startEra,
      hp: eraInfo.cityMaxHp,
      maxHp: eraInfo.cityMaxHp,
      armor: eraInfo.cityArmor,
    });
    for (let dy = 0; dy < CITY.size; dy++) {
      for (let dx = 0; dx < CITY.size; dx++) {
        const tile = tiles[(top + dy) * w + (left + dx)];
        if (!tile) continue;
        tile.terrain = 'city';
        tile.cityId = id;
      }
    }
  };

  for (const c of layout.citiesA) placeCity('A', c.x, c.y);
  for (const c of layout.citiesB) placeCity('B', c.x, c.y);

  // ---- 单位 ----
  const units: Unit[] = [];
  let unitSeq = 1;
  const pushUnit = (owner: PlayerId, type: string, x: number, y: number) => {
    const def = unitTypes[type] ?? Object.values(unitTypes)[0];
    if (!def) throw new Error('没有可用兵种');
    // 兜底：万一候选池里只剩水军（玩家把陆军全禁了），也不能把船摆上岸
    if (def.domain === 'water') return;
    units.push({
      id: `u${unitSeq++}`,
      type: def.id,
      owner,
      x,
      y,
      hp: def.maxHp,
      kills: 0,
      moved: false,
      acted: false,
    });
  };

  for (const s of layout.spawnsA) pushUnit('A', s.type, s.x, s.y);
  for (const s of layout.spawnsB) pushUnit('B', s.type, s.x, s.y);

  // 开局送两个经济单位，摆在自家城外的空地上——
  // 农民要站在平原才有产出，所以不能塞进城里
  const econPool = pool.filter((id) => {
    const d = catalog[id];
    return d?.era === 1 && d.category === 'economy';
  });
  if (econPool.length > 0) {
    for (const owner of ['A', 'B'] as PlayerId[]) {
      const ownCity = cities.find((c) => c.owner === owner);
      if (!ownCity) continue;
      for (let k = 0; k < 2; k++) {
        const type = econPool[k % econPool.length] as string;
        const spot = freeSpotNear(tiles, w, h, ownCity, units);
        if (spot) pushUnit(owner, type, spot.x, spot.y);
      }
    }
  }

  const state: GameState = {
    version: 4,
    seed,
    config: {
      size: config.size,
      startEra,
      mapStyle: config.mapStyle ?? 'random',
      mapSymmetry: config.mapSymmetry ?? 'fair',
      aiOpponent: config.aiOpponent,
      aiAlly: config.aiAlly,
      aiLevel: config.aiLevel === 'basic' ? 'basic' : 'advanced',
      // 统一按注册顺序排好：钩子叠加是有顺序的，顺序漂移会破坏可复现性
      expansionIds: EXPANSIONS.filter((e) => config.expansionIds.includes(e.id)).map((e) => e.id),
      enabledUnits: [...pool],
      commanderMode: config.commanderMode === true,
    },
    unitTypes,
    turn: 1,
    current: 'A',
    w,
    h,
    tiles,
    cities,
    units,
    players: {
      A: { id: 'A', name: '我方', gold: startGoldFor(startEra) },
      B: { id: 'B', name: '敌方', gold: startGoldFor(startEra) },
    },
    nextUnitSeq: unitSeq,
    fog: CONFIG.fogDefault,
    winner: null,
    log: [],
    memory: {
      A: { known: [] },
      B: { known: [] },
    },
  };

  // "过河只能架桥"这种事必须开局就说清楚。
  // 玩家没有义务从一张缩略图里看出"这条河没有渡口"，
  // 而他要为这件事做的是十个回合的准备。
  if (layout.fordless) {
    state.log.push({
      turn: 1,
      player: 'A',
      text: '这一局的河没有渡口，过河只能架桥',
    });
  }

  // 开局类扩展（改变初始金币、城市耐久等）
  for (const e of activeExpansions(state)) {
    e.hooks.onMatchStart?.({ state });
  }

  // 后手补偿：按"实际拿到的开局本金"补一笔。
  // 放在扩展之后算——大征兵那种"开局金币减半"的规则会改本金，补偿要跟着改后的数走，
  // 否则在开了大征兵的局里，5% 会变成"原价本金的 5%"，比预期多一倍。
  //
  // 比例由「先后手补偿」扩展给（按棋盘边长查表），`config.secondGoldBonus` 是
  // 跑批时临时压过它的旋钮：给了正数就以旋钮为准，方便在同一套扩展下扫不同补偿量。
  let bonusRatio = 0;
  for (const e of activeExpansions(state)) {
    bonusRatio += e.hooks.modifySecondGold?.({ state }) ?? 0;
  }
  const override = config.secondGoldBonus ?? 0;
  if (override > 0) bonusRatio = override;
  if (bonusRatio > 0) {
    const extra = Math.round(state.players.B.gold * bonusRatio);
    if (extra > 0) {
      state.players.B.gold += extra;
      state.log.push({
        turn: 1,
        player: 'B',
        text: `先后手补偿：开局金币 +${extra}（${Math.round(bonusRatio * 1000) / 10}%）`,
      });
    }
  }

  // 先手也要拿到"第一回合收入"。
  // 放在扩展之后：大征兵那种"起始金币减半"应该只减起始本金，不该把这一回合的
  // 收入也一起砍掉——那一份钱是两边都该有的。
  //
  // 想试"先手不领这第一笔"的配平方案时把这个开关打开：
  // 先手就只剩"先动一步"，钱要等自己第一个回合开始才到账。
  if (!config.noFirstIncome) grantOpeningIncome(state);

  refreshMemory(state);
  return state;
}

/** 在城外围着城市找一块能站人的空地 */
function freeSpotNear(
  tiles: Tile[],
  w: number,
  h: number,
  city: City,
  units: Unit[],
): { x: number; y: number } | null {
  const cx = city.x + Math.floor(city.size / 2);
  const cy = city.y + Math.floor(city.size / 2);
  for (let r = 2; r <= 7; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const t = tiles[y * w + x];
        if (!t || !passable(t.terrain) || t.terrain === 'city') continue;
        if (units.some((u) => u.x === x && u.y === y)) continue;
        return { x, y };
      }
    }
  }
  return null;
}

/** 生成一个随机的开局种子，UI 用 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2_000_000_000) + 1;
}
