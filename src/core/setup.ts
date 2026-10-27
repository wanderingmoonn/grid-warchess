/**
 * 开局：把一份对局配置变成一局具体的游戏。
 *
 * 配置里只有"选了什么"（棋盘多大、开哪些扩展、用哪些兵种），
 * 地形和部署由 seed 决定性地生成出来。
 * 同一个 (config, seed) 永远得到完全一样的一局，回放和联机才有意义。
 */

import { CITY, CONFIG, ERAS, UNIT_TYPES, eraDef, passable } from './config.ts';
import { EXPANSIONS, activeExpansions, enabledExpansionIds, expansionById } from './expansions.ts';
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

/**
 * 开局界面里的预设棋盘尺寸
 *
 * 32 是"长期局"档：五个时代全开、打到现代也不嫌挤，但一格只有二十来像素，
 * 所以界面上配了缩放（见 main.ts 的 fitBoard / zoom）。
 * 它不跟任何时代绑定——20×20 仍是火药及以后的标准图。
 *
 * 预设之外还能自己填边长：**4 ~ 64**，见 clampBoardSize。
 */
export const BOARD_SIZES = [12, 16, 20, 32];

/**
 * 棋盘边长的硬边界。
 *
 * 下限 4：再小连两座 2×2 的城都摆不下（4×4 正好是 16 格，一城一边）。
 * 这种图走 mapgen 里的 tinyLayout——一城一边、不画河不画山脊。
 * 上限 64：4096 格，再大就不是"看清楚"的问题了，是浏览器扛不扛得住
 * 每帧重绘 4000 个格子。64 已经要配合 3 倍缩放才看得清一角。
 */
export const MIN_BOARD_SIZE = 4;
export const MAX_BOARD_SIZE = 64;

/** 把任意输入夹到合法范围：非数字、小数、越界都统一处理掉 */
export function clampBoardSize(n: unknown): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return DEFAULT_CONFIG.size;
  return Math.max(MIN_BOARD_SIZE, Math.min(MAX_BOARD_SIZE, Math.round(v)));
}

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

/**
 * 默认双方名字的老写法。
 *
 * 名字是存进 state 的（日志、顶栏、交接遮罩都直接读它），所以改默认名
 * 不能只改这一处——旧存档、云端房间、导入的对局里都还躺着老字符串。
 * 这里只在"名字还等于旧默认值"时才替换，玩家自己改过的名字一律不动。
 */
const LEGACY_PLAYER_NAMES: Record<PlayerId, string> = { A: '我方', B: '敌方' };
const DEFAULT_PLAYER_NAMES: Record<PlayerId, string> = { A: '红方', B: '蓝方' };

/** 就地把旧默认名换成新默认名；返回是否动过（调用方据此决定要不要回存） */
export function normalizePlayerNames(s: GameState): boolean {
  let touched = false;
  for (const p of ['A', 'B'] as PlayerId[]) {
    if (s.players?.[p]?.name === LEGACY_PLAYER_NAMES[p]) {
      s.players[p].name = DEFAULT_PLAYER_NAMES[p];
      touched = true;
    }
  }
  return touched;
}

export function createMatch(
  config: MatchConfig,
  seed: number,
  customUnits: Record<string, UnitTypeDef> = {},
): GameState {
  // 先合并：内置兵种 + 玩家自定义 + 已启用扩展自带的兵种
  //
  // 注意这里用的是 enabledExpansionIds 而不是 config.expansionIds：
  // 前置包没开的时候，依赖它的兵种包必须整包不进場。否则玩家会拿到一堆
  // "有魔法攻击但魔法抗性永远读不到"的兵——比直接不出现更糟。
  const liveExpansions = enabledExpansionIds(config.expansionIds);
  const extraUnits: Record<string, UnitTypeDef> = { ...customUnits };
  for (const id of config.expansionIds) {
    if (!liveExpansions.has(id)) continue;
    for (const u of expansionById(id)?.units ?? []) extraUnits[u.id] = { ...u };
  }
  const catalog: Record<string, UnitTypeDef> = { ...UNIT_TYPES, ...extraUnits };

  // 城市边长：扩展可以要求更大的主城（「城郭与物料」要 3×3）。
  // 取所有启用扩展里最大的那个；没写就用 config 里的值，再没有就 2。
  const declaredCitySize = Math.max(
    CITY.size,
    ...config.expansionIds
      .filter((id) => liveExpansions.has(id))
      .map((id) => expansionById(id)?.citySize ?? 0),
  );
  const citySize = Math.max(CITY.size, Math.round(config.citySize ?? declaredCitySize));

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
    clampBoardSize(config.size),
    seed,
    spawnPool,
    {
      style: config.mapStyle ?? 'random',
      symmetry: config.mapSymmetry ?? 'fair',
      citySize,
    },
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
      size: citySize,
      owner,
      era: startEra,
      hp: eraInfo.cityMaxHp,
      maxHp: eraInfo.cityMaxHp,
      armor: eraInfo.cityArmor,
    });
    for (let dy = 0; dy < citySize; dy++) {
      for (let dx = 0; dx < citySize; dx++) {
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
      size: clampBoardSize(config.size),
      startEra,
      mapStyle: config.mapStyle ?? 'random',
      mapSymmetry: config.mapSymmetry ?? 'fair',
      // 城市边长要存进存档：读档之后建城、上帝模式摆城、界面画城都读它
      citySize,
      aiOpponent: config.aiOpponent,
      aiAlly: config.aiAlly,
      aiLevel: config.aiLevel === 'basic' ? 'basic' : 'advanced',
      // 统一按注册顺序排好：钩子叠加是有顺序的，顺序漂移会破坏可复现性。
      // 前置没满足的整条剔掉——配置里留着它也没用，反而会让"这局开了什么"
      // 在存档里显示成一句谎话。
      expansionIds: EXPANSIONS.filter((e) => liveExpansions.has(e.id)).map((e) => e.id),
      enabledUnits: [...pool],
      commanderMode: config.commanderMode === true,
      godMode: config.godMode === true,
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
      A: { id: 'A', name: '红方', gold: startGoldFor(startEra) },
      B: { id: 'B', name: '蓝方', gold: startGoldFor(startEra) },
    },
    nextUnitSeq: unitSeq,
    // 上帝模式一律关雾。
    //
    // 不只是"看着爽"：AI 找方向靠两样东西——敌方的城，和**自己视野里**的敌军
    // （见 ai.ts 的 advanceDistance）。沙盒里常常一座城都不摆，这时候它唯一的
    // 方向来源就是看得见的敌人。实测（12×12、两边各 6 个民兵、一块平地、
    // 没有城）：雾开着，12 个兵两排站到第 80 回合谁都没动一下，aiNextAction
    // 直接返回 null；雾一关，5 个回合就打完了一边。
    // 所以这个模式下雾不是偏好，是必须关掉。
    fog: config.godMode === true ? false : CONFIG.fogDefault,
    winner: null,
    log: [],
    memory: {
      A: { known: [] },
      B: { known: [] },
    },
  };

  // 开局编制类扩展：整批换掉默认的那套开局部队。
  //
  // 放在 state 建好之后、onMatchStart 之前：开局钩子里（大征兵那类）会读
  // "这局开局给了什么"，如果它先跑，看到的就是默认那五个，跟实际摆出来的对不上。
  for (const e of activeExpansions(state)) {
    const roster = e.hooks.startRoster?.({ state });
    if (!roster) continue;
    state.units = [];
    for (const owner of ['A', 'B'] as PlayerId[]) {
      const list = roster[owner] ?? [];
      const ownCity = state.cities.find((c) => c.owner === owner);
      if (!ownCity) continue;
      for (const type of list) {
        const def = state.unitTypes[type];
        if (!def) continue;
        const spot = freeSpotNear(state.tiles, state.w, state.h, ownCity, state.units);
        if (!spot) continue;
        state.units.push({
          id: `u${state.nextUnitSeq++}`,
          type: def.id,
          owner,
          x: spot.x,
          y: spot.y,
          hp: def.maxHp,
          kills: 0,
          moved: false,
          acted: false,
        });
      }
    }
    // 日志写"这一局到底发了什么"，而不是写死一句话：
    // 以后再有扩展换开局编制，这句话不能变成谎话。
    const names = (ids: string[] | undefined): string =>
      (ids ?? []).length > 0
        ? (ids ?? []).map((id) => state.unitTypes[id]?.name ?? id).join(' + ')
        : '无';
    state.log.push({
      turn: 1,
      player: 'A',
      text: `${e.name}：${state.players.A.name} ${names(roster.A)}，${state.players.B.name} ${names(roster.B)}`,
    });
    break;
  }

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
