/**
 * 开局：把一份对局配置变成一局具体的游戏。
 *
 * 配置里只有"选了什么"（棋盘多大、开哪些扩展、用哪些兵种），
 * 地形和部署由 seed 决定性地生成出来。
 * 同一个 (config, seed) 永远得到完全一样的一局，回放和联机才有意义。
 */

import { CITY, CONFIG, UNIT_TYPES, eraDef, isPseudoUnit, passable } from './config.ts';
import {
  EXPANSIONS,
  activeExpansions,
  enabledExpansionIds,
  eraCeilingFor,
  expansionById,
  normalizeExpansionIds,
} from './expansions.ts';
import { createDraft } from './draft.ts';
import { generateLayout, generateMultiLayout, layoutFromRows, terrainFromChar, twoCityMinSize } from './mapgen.ts';
import { validateFixedMap } from './fixed-maps.ts';
import { validateLevel } from './level.ts';
import { canStandAt, refreshMemory, grantOpeningIncome } from './rules.ts';
import { PLAYER_ORDER } from './types.ts';
import type { City, GameState, MatchConfig, PlayerId, Tile, Unit, UnitTypeDef } from './types.ts';
import type { SpawnDef } from './mapgen.ts';
import { registerResource } from './resources.ts';
import { nextRandom } from './rng.ts';

/**
 * 开局界面里的预设棋盘尺寸
 *
 * 32 是"长期局"档：五级链条全开、打到第六时代也不嫌挤，但一格只有二十来像素，
 * 所以界面上配了缩放（见 main.ts 的 fitBoard / zoom）。
 * 它不跟任何时代绑定——20×20 仍是火器及以后的标准图。
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
 * 标准对局的默认组合：青铜时代 + 12×12。
 *
 * 时代和尺寸是配套的（青铜 12×12 / 铁器 16×16 / 火器及以后 20×20）：
 * 青铜兵走得慢、打得近，图大了两边要磨十个回合才照面；
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
  // （实测未决率 5.8%→0.8%、铁器 17.5%→10.0%，平均少打 15~19 回合）。
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
 * 从信息化开局的第一回合你连一个兵都造不出来，只能干等收入——那不叫"快节奏开局"，
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
// C/D 从来没有过"我方/敌方"这种旧默认名，所以它们的旧值就等于新值——
// 这条迁移只对 A/B 生效，写成同一份只是为了满足 Record 的四个键。
const LEGACY_PLAYER_NAMES: Record<PlayerId, string> = { A: '我方', B: '敌方', C: '绿方', D: '黄方' };
/**
 * 默认名字跟着席位走：红 / 蓝 / 绿 / 黄。
 *
 * 三家四家局里光看"我方/敌方"是分不清的，所以默认名直接用颜色——
 * 棋盘上的配色、血条、战报名字用的也是同一套（见 style.css 的 own-*）。
 */
export const DEFAULT_PLAYER_NAMES: Record<PlayerId, string> = { A: '红方', B: '蓝方', C: '绿方', D: '黄方' };

/** 就地把旧默认名换成新默认名；返回是否动过（调用方据此决定要不要回存） */
export function normalizePlayerNames(s: GameState): boolean {
  let touched = false;
  for (const p of PLAYER_ORDER) {
    // 老存档只有两个席位，别为不存在的 C/D 造一条出来
    if (!s.players?.[p]) continue;
    // C/D 的"旧默认名"就等于新默认名：拿它去比会得出"改过了"的假结论，
    // 于是每次读档都白回存一次。名字本来就一样的席位直接跳过。
    if (LEGACY_PLAYER_NAMES[p] === DEFAULT_PLAYER_NAMES[p]) continue;
    if (s.players[p].name === LEGACY_PLAYER_NAMES[p]) {
      s.players[p].name = DEFAULT_PLAYER_NAMES[p];
      touched = true;
    }
  }
  return touched;
}

/**
 * 这组扩展一共带来哪些兵种。
 *
 * 抽成独立函数是因为现在有**两处**要问这个问题，而它们必须给出同一个答案：
 *   · createMatch——决定这一局的 `state.unitTypes` 里有什么；
 *   · 开局面板的兵种池弹层——决定列表里该出现哪些格子。
 * 两边各写一遍的话，面板上勾着的船在进局后"造不出来"只是时间问题。
 *
 * 前置两条都要查：包级 `enabledExpansionIds`（前置包没开就不算），
 * 以及单位级 `requiresPack`（圣剑勇者要「信息化」那套才成立）。
 */
export function expansionUnitsFor(expansionIds: string[]): Record<string, UnitTypeDef> {
  const live = enabledExpansionIds(expansionIds);
  const out: Record<string, UnitTypeDef> = {};
  for (const id of expansionIds) {
    if (!live.has(id)) continue;
    for (const u of expansionById(id)?.units ?? []) {
      if (u.requiresPack && !live.has(u.requiresPack)) continue;
      out[u.id] = { ...u };
    }
  }
  return out;
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
  /*
   * 关卡（可选）。**必须最先解析**：它决定开哪些扩展、几家、谁托管、地图、开局部署。
   *
   * 校验不过就当作没有关卡（退回普通对局），而不是让整局建不起来——
   * 和固定地图的兜底同一条理由：一份坏配置不该让玩家连开局都开不了。
   */
  const checkedLevel = config.level ? validateLevel(config.level) : null;
  const level = checkedLevel && checkedLevel.ok ? checkedLevel.level : null;

  /*
   * 先把扩展 id 迁移成现在的写法（2026-11-04 十六个包并成四个）。
   *
   * 这一步必须在这里做，不能只做在 enabledExpansionIds 里面：下面好几处是
   * "遍历玩家勾的那串 id、再去 canonical 集合里查在不在"（expansionUnitsFor、
   * citySize、开局战报里的 extensions 列表）。集合里是新 id、数组里是旧 id 时，
   * 每个都查不到——表现就是"勾了奇想包，兵种表里一个奇想兵都没有"。
   */
  /*
   * 关卡对扩展的要求，在归一化**之前**套上去。
   *
   * 顺序是"先剔禁用的、再补必须开的"：
   *   · 禁用优先，因为作者的意图是"这一关不能带这个包"，玩家勾了也不算；
   *   · 必须开的补在最后，`validateLevel` 已经保证同一个包不会两头都写。
   *
   * 只动这一局的局部量，**不改调用方的 config**（createMatch 是纯函数）。
   * 真正生效的集合会由下面 `state.config.expansionIds` 按"实际进场的包"重写，
   * 所以存档里记的是真实值，不是玩家勾的那串。
   */
  const levelExpansions = level?.expansions;
  const wantExpansions = (() => {
    const base = [...config.expansionIds];
    if (!levelExpansions) return base;
    const forbid = new Set(levelExpansions.forbid ?? []);
    const kept = base.filter((id) => !forbid.has(id));
    for (const id of levelExpansions.require ?? []) {
      if (!forbid.has(id) && !kept.includes(id)) kept.push(id);
    }
    return kept;
  })();
  const expansionIds = normalizeExpansionIds(wantExpansions);

  const extraUnits: Record<string, UnitTypeDef> = {
    ...customUnits,
    ...expansionUnitsFor(expansionIds),
  };
  // 城市边长那边还要按包查一次，所以这份集合留着
  const liveExpansions = enabledExpansionIds(expansionIds);
  const catalog: Record<string, UnitTypeDef> = { ...UNIT_TYPES, ...extraUnits };

  // 城市边长：扩展可以要求更大的主城（「城郭与物料」要 3×3）。
  // 取所有启用扩展里最大的那个；没写就用 config 里的值，再没有就 2。
  const declaredCitySize = Math.max(
    CITY.size,
    ...expansionIds
      .filter((id) => liveExpansions.has(id))
      .map((id) => expansionById(id)?.citySize ?? 0),
  );
  const citySize = Math.max(CITY.size, Math.round(config.citySize ?? declaredCitySize));

  // 本局启用的扩展带来的资源：登记进 RESOURCES（本局流通表）。
  // 名字兜底已由 expansions.ts 在模块加载时全量登记（规则书 / 开局面板 /
  // 联机加入 / 读档都不走 createMatch，也得查得到中文名），这里再调一次是幂等的。
  // RESOURCES 的长度和顺序仍由本局决定——RL 特征向量按它开槽。
  for (const id of config.expansionIds) {
    if (!liveExpansions.has(id)) continue;
    for (const r of expansionById(id)?.resources ?? []) registerResource(r);
  }

  /**
   * 这一局几家。
   *
   * 关卡写了就算关卡的（那是这一关的设计），没写才看面板。
   *
   * 注意下面那条老注释此刻只对"普通对局 + 固定地图"成立：固定地图只有两个城位
   * （`citiesA/B`），所以不提供第三四家的城。**关卡不受这条限制**——它自己带
   * `seats.cities` 给第三四席，见 `LevelSeats`。
   */
  const playerCount = (level?.seats?.count ?? config.playerCount ?? 2) as 2 | 3 | 4;
  /**
   * 三人四人局：托管整方的 AI 开关以前按两席关掉，现在不关了。
   *
   * 选卡 BP 和"先后手补偿"仍然只按两个席位写（BP 界面只有两栏、补偿只算两家），
   * 这两样在多人局照样关；但"谁被电脑操作"已经不是两席的事情了：
   * AI 的多方目标选择在 2026-11-04 放宽成"所有敌人"（见 ai.ts 的 enemyUnitsOf），
   * 三家四家局里让丙丁交给电脑，它打得动。
   */
  const twoSeats = playerCount === 2;
  const draftMode = twoSeats && config.draftMode === true;
  /** 这一局坐人的席位，按行动顺序 */
  const seatList = PLAYER_ORDER.slice(0, playerCount) as PlayerId[];
  /**
   * 哪些席位交给电脑。三层优先级，写死顺序：
   *   1. 关卡规定的（这一关的设计）；
   *   2. 面板给的 `config.aiSeats`；
   *   3. 都没有 → 按老的两个布尔推导（两家局的老存档走这条）。
   *
   * 三个字段的关系见 `MatchConfig.aiSeats`。注意 `[]` 是**有含义**的（全是真人），
   * 所以判"有没有设置过"用的是 `!== undefined`，不是长度。
   */
  const aiSeatList: PlayerId[] = (() => {
    const declared = level?.seats?.ai ?? config.aiSeats;
    if (declared !== undefined) return seatList.filter((p) => declared.includes(p));
    const legacy: PlayerId[] = [];
    if (config.aiAlly === true) legacy.push('A');
    if (config.aiOpponent === true) legacy.push('B');
    return legacy.filter((p) => seatList.includes(p));
  })();
  /*
   * 老的两个布尔继续写进 config，值由 `aiSeatList` 反算。
   *
   * 为什么还留着：报告、面板、指挥官模式判定都还在读它们，而且**两家局必须
   * 逐字保持原样**（一局人机对战的老复盘要靠这两个字段认出"蓝方是电脑"）。
   * 两家局下 `aiSeatList` 就来自这两个布尔，反算回去是恒等的。
   */
  const aiOpponent = twoSeats && aiSeatList.includes('B');
  const aiAlly = twoSeats && aiSeatList.includes('A');
  const commanderMode = config.commanderMode === true;

  const enabled = config.enabledUnits.filter((id) => catalog[id]);
  /**
   * 选卡模式下池子必须是**全部兵种**。
   *
   * 理由很直接：选卡是从"这一局有哪些兵"里挑，而 `state.unitTypes` 决定了
   * "这局存在哪些兵"。如果只放开启的那部分，玩家在 BP 里看到的候选
   * 一旦落在外面，选中了也造不出来——面板上写着"已选"，按下去却说没有这个兵。
   * 开局面板里逐个勾兵的开关在这个模式下没有意义（名单由 BP 决定），所以直接全开。
   */
  const pool = (
    draftMode
      ? Object.keys(catalog)
      : enabled.length > 0
        ? enabled
        : Object.keys(UNIT_TYPES)
  ).filter((id) => !isPseudoUnit(id));
  // 勾了某个扩展，它带的兵种就默认进场，不用再单独勾
  for (const id of Object.keys(extraUnits)) {
    if (!pool.includes(id)) pool.push(id);
  }
  /**
   * 显式关掉的兵种从这里剔出去。
   *
   * 这一步必须放在"扩展兵默认进场"**之后**：默认进场是规则，关掉是玩家在这条
   * 规则上开的一个口子。顺序反过来，被关掉的船会在下一行又被加回池子里——
   * 面板上看着是关的，进局照样能造。
   */
  const disabled = new Set(config.disabledUnits ?? []);
  if (disabled.size > 0) {
    for (let i = pool.length - 1; i >= 0; i--) {
      if (disabled.has(pool[i])) pool.splice(i, 1);
    }
  }
  // 全关掉了（配置从存档/链接进来，没经过面板那道"至少留一个"的关）：
  // 退回本体兵种，别拿一个空池去开局——那样连产线都起不来。
  // 这一次连 disabled 也不看了：空池比"不听你的"更糟。
  if (pool.length === 0) {
    for (const id of Object.keys(UNIT_TYPES)) {
      if (!isPseudoUnit(id)) pool.push(id);
    }
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
  /*
   * 地图：要么是玩家选定的固定地图，要么按种子生成。
   *
   * 固定地图在**这里再校验一遍**，而不是信调用方：`config` 会跟着存档、
   * 联机房间、分享链接一路传，谁都能改它。校验不过就退回随机生成——
   * 一张坏图不该让整局建不起来，但也不能让它带着半张地形进场。
   */
  /*
   * 关卡自带的地图**优先于** `config.fixedMap`。
   *
   * 关卡是"在哪打 + 怎么打"的整包，它的地图是这一关的一部分；面板上那张固定图
   * 只是上一局留下的记忆，不该覆盖关卡。这里仍然过一遍校验：虽然 `validateLevel`
   * 已经查过，但这一步是"所有地图进场的唯一关口"，多查一次换来的是
   * "不存在一条绕过校验的地图路径"。
   */
  const levelMap = level?.map ?? null;
  const fixedSource = levelMap ?? config.fixedMap ?? null;
  const fixed = fixedSource ? validateFixedMap(fixedSource) : null;
  /*
   * 城位可能"贴边"，而本局的城可能是 3×3（「城郭」扩展）。
   *
   * 地图里的城位只保证 2×2 框得进棋盘（见 validateFixedMap），开城郭之后
   * 同一座贴边的城就会伸出棋盘外——那不是玩家的错，是这张图配这个扩展时
   * 放不下。这里按棋盘边长**夹一次**（物理约束），而不是在导出/上传那一步
   * 拒绝整张图：图本身没毛病，是这一局的城更大。
   */
  const fixedMap = fixed && fixed.ok ? fixed.map : null;
  const clampCityInto = (c: { x: number; y: number }): { x: number; y: number } => ({
    x: Math.max(0, Math.min(Math.max(0, (fixedMap?.w ?? 0) - citySize), c.x)),
    y: Math.max(0, Math.min(Math.max(0, (fixedMap?.h ?? 0) - citySize), c.y)),
  });
  /*
   * 多席位能不能用这张固定地图。
   *
   * 固定地图（含关卡地图）只有 A/B 两组城位，第三四席的城由关卡额外给。
   * 所以"三家四家 + 固定地图"成立的条件是：**每一个多出来的席位都有城**。
   * 缺一个就不走固定布局，退回生成器——宁可换一张随机图，也不要造出
   * "有一家没城、第一回合就出局"的局面（那看起来像 bug，其实是配置错）。
   */
  const extraCities = level?.seats?.cities ?? {};
  const multiOk =
    playerCount === 2 || seatList.slice(2).every((p) => (extraCities[p as 'C' | 'D']?.length ?? 0) > 0);
  /* 第三四席的城也要夹一次：理由和 A/B 完全相同（开城郭之后 3×3 会伸出棋盘） */
  const clampExtraCities = (): Partial<Record<'C' | 'D', Array<{ x: number; y: number }>>> => {
    const out: Partial<Record<'C' | 'D', Array<{ x: number; y: number }>>> = {};
    if (extraCities.C) out.C = extraCities.C.map(clampCityInto);
    if (extraCities.D) out.D = extraCities.D.map(clampCityInto);
    return out;
  };
  const layout =
    fixedMap && multiOk
      ? layoutFromRows(
          fixedMap.rows,
          fixedMap.citiesA.map(clampCityInto),
          fixedMap.citiesB.map(clampCityInto),
          spawnPool,
          citySize,
          clampExtraCities(),
        )
      : playerCount > 2
        ? generateMultiLayout(
            /*
             * 双城市开局：棋盘**不许小于约束要求**。
             *
             * 八座城要摆在外圈八个格点上，间距是 (边长 - 2 - 城边)/2；
             * 不够大就直接抬到最小边长，而不是摆出两座贴脸的城——
             * "所有城市之间的最低间距"是这条选项的硬条件，不能靠玩家自己发现。
             */
            config.twoCities ? Math.max(clampBoardSize(config.size), twoCityMinSize(citySize, playerCount === 3 ? 3 : 4)) : clampBoardSize(config.size),
            seed,
            spawnPool,
            {
              players: playerCount === 3 ? 3 : 4,
              citySize,
              style: config.mapStyle,
              twoCities: config.twoCities === true,
              // 和双人同一个口径：只有本局真正启用的扩展才能贡献地貌
              // （高原/峡谷/沼泽/群岛/大川）。扩展关掉，这几种就不该出现。
              expansions: expansionIds.filter((id) => liveExpansions.has(id)),
            },
          )
        : generateLayout(
            clampBoardSize(config.size),
            seed,
            spawnPool,
            {
              style: config.mapStyle ?? 'random',
              symmetry: config.mapSymmetry ?? 'fair',
              citySize,
              // 只能画本局真正启用的扩展带来的地形。关掉「地形高差」的局里
              // 一格台地/熔岩都不会出现——老规则、老存档不受影响。
              expansions: expansionIds.filter((id) => liveExpansions.has(id)),
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
      tiles.push({ terrain: terrainFromChar(ch), cityId: null });
    }
  }

  // ---- 本局实际使用的兵种表 ----
  const unitTypes: Record<string, UnitTypeDef> = {};
  for (const id of pool) {
    const def = catalog[id];
    if (!def) continue;
    /*
     * 浅拷贝**不够**：`builds` 这类数组还是和目录里的同一份。
     *
     * 扩展包会就地改它（`attachShipyards` 往工程兵的 builds 里 push 船坞），
     * 于是"开了一局带海军的"会把船坞永久钉进模块级的 `UNIT_TYPES`——
     * 同一个进程里之后所有局的奴隶都变成"会造船坞但造不出来"，
     * `test-rules` 里那条选卡用例就是这么炸的（`s.unitTypes[nv-dock]` 是 undefined）。
     *
     * 修在这里而不是各扩展里：这一层的契约本来就是"每个 state 一份私有的兵种表"，
     * 让它真的私有，比让十几个扩展各自记得"别 push"可靠。
     */
    unitTypes[id] = { ...def, builds: def.builds ? [...def.builds] : undefined };
  }

  // ---- 城市 ----
  const cities: City[] = [];
  let citySeq = 1;
  // 开局时代也要按"这一局能走到第几级"夹住：不勾「现代战争」时，
  // 配置里写 startEra: 6 只该得到第五时代，而不是一座没有兵可用、也再造不出兵的城。
  const startEra = Math.max(1, Math.min(eraCeilingFor(expansionIds), config.startEra));
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

  /** 这一局实际坐人的席位，按行动顺序（= 前面算 aiSeatList 用的那份） */
  const seats = seatList;

  /*
   * 谁先动。
   *
   * 两人局才认（见 MatchConfig.firstSide）：三四人局的席位顺序还牵着出生点和城位，
   * 让玩家任选先手等于让一张图的公平性取决于一个下拉框。
   *
   * `random` 用种子抽、**抽完就落成 'A'/'B' 存进 config**：复盘要逐帧还原，
   * 存档里留一个"随机"字样，就等于每次打开都可能换一个先手。
   */
  const firstSeat: PlayerId = (() => {
    const want = config.firstSide;
    /*
     * 随机：两人局抽 A/B，三四人局**在所有席位上抽**（等于随机轮转起点）。
     *
     * 多人局的回合本来就是环形的（`nextSeat` 按席位列环转），所以"从谁开始"
     * 只影响起点、不影响循环——C 先手就是 C→D→A→B，和 A 先手是同一个环。
     * 城位与出生点按席位固定分配，不跟着这个走（席位=地图位置，先手=谁先动）。
     */
    if (want === 'random') {
      const n = seats.length;
      if (n <= 1) return 'A';
      // 用 0~1 的随机数乘以席位数取整：n=2 时退化成 A/B 各一半
      const idx = Math.min(n - 1, Math.floor(nextRandom((seed ^ 0x1f2e3d4c) >>> 0).value * n));
      return seats[idx]!;
    }
    // 指定先手只在两人局认：多人局让玩家任选先手，等于让一张图的公平性取决于下拉框
    if (twoSeats && (want === 'A' || want === 'B')) return want;
    return 'A';
  })();
  /** 布局里某一家分到的城位（两家局只有 A/B，三家四家才多出来） */
  const layoutCities: Record<PlayerId, Array<{ x: number; y: number }>> = {
    A: layout.citiesA,
    B: layout.citiesB,
    C: layout.citiesC ?? [],
    D: layout.citiesD ?? [],
  };
  const layoutSpawns: Record<PlayerId, SpawnDef[]> = {
    A: layout.spawnsA,
    B: layout.spawnsB,
    C: layout.spawnsC ?? [],
    D: layout.spawnsD ?? [],
  };

  for (const p of seats) for (const c of layoutCities[p]) placeCity(p, c.x, c.y);

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

  /*
   * 关卡点了名的席位**不自动撒兵**：作者写"你只有 1 个兵"，开局就不该变成四个。
   * 真正摆那几个兵要等 state 建好（见下面的 `levelDeploy` 那一段）。
   */
  const levelDeploy = level?.deploy ?? {};
  for (const p of seats) {
    if ((levelDeploy[p]?.length ?? 0) > 0) continue;
    for (const s of layoutSpawns[p]) pushUnit(p, s.type, s.x, s.y);
  }

  // 开局送两个经济单位，摆在自家城外的空地上——
  // 农民要站在平原才有产出，所以不能塞进城里
  const econPool = pool.filter((id) => {
    const d = catalog[id];
    return d?.era === 1 && d.category === 'economy';
  });
  if (econPool.length > 0) {
    for (const owner of seats) {
      // 关卡写了部署的席位也不送经济单位：那会把它写死的兵力再加两个，
      // 而作者要的正是"就这几个人"。
      if ((levelDeploy[owner]?.length ?? 0) > 0) continue;
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
      aiOpponent,
      aiAlly,
      /*
       * 通用写法：哪些席位由电脑操作。**永远写**，包括空数组。
       *
       * 空数组是有含义的（全是真人），而 `isAiSide` 判的是"这个字段有没有"——
       * 不写空数组的话，一份三人全人局的 config 会落进"老存档"分支，
       * 回头去读 aiOpponent/aiAlly，那是两家局的语义，会读出一个假的答案。
       */
      aiSeats: [...aiSeatList],
      aiLevel:
        config.aiLevel === 'basic'
          ? 'basic'
          : config.aiLevel === 'tactic'
            ? 'tactic'
            : 'advanced',
      /*
       * 内核：`net` = 自博弈练出来的策略网络（见 rl/brain.ts）。
       *
       * 和上面那些开关一样必须逐个抄进 state.config：读档、复盘、上报、
       * 以及 AI 走子那一刻选哪个内核，读的都是这里。
       *
       * 只在**两席局**里认：那个网络是在 2 人、10×10/12×12 上练的，
       * 三家四家的目标选择与席位顺序它一次都没见过——真让它上不叫测试。
       */
      aiBrain: twoSeats && config.aiBrain === 'net' ? 'net' : 'script',
      // 统一按注册顺序排好：钩子叠加是有顺序的，顺序漂移会破坏可复现性。
      // 前置没满足的整条剔掉——配置里留着它也没用，反而会让"这局开了什么"
      // 在存档里显示成一句谎话。
      expansionIds: EXPANSIONS.filter((e) => liveExpansions.has(e.id)).map((e) => e.id),
      enabledUnits: [...pool],
      // 关掉的那些也要活进 config：兵种池弹层靠它把"关着"的格子画回去，
      // 少了这一行，下一局打开面板会看到整排船又亮了起来。
      disabledUnits: Array.from(disabled).filter((id) => catalog[id]),
      // 人数必须活进 state.config：席位（谁上场、轮到谁、谁还活着）全靠它，
      // 和上面那些开关一样，这个是逐个白名单抄的，漏一个就等于被吃掉。
      playerCount,
      // 时代路线：不填就是 linear（每级 +1 的老科技线）。
      // 必须逐个白名单抄进 config——这里漏一个，存档读回来就退回线性表，
      // 而"这局用的是哪条线"恰恰是最不该悄悄变的东西。
      ...(config.eraRoute ? { eraRoute: config.eraRoute } : {}),
      // 两个字段分工见 MatchConfig：
      //   firstSide = 玩家选的档位（面板记忆）；firstSeat = 实际先手（规则读它）。
      firstSide: config.firstSide === 'B' || config.firstSide === 'random' ? config.firstSide : 'A',
      /*
       * 永远写，哪怕先手就是 A。
       *
       * 一开始只在"不是 A"时才写（想少给老存档加键），结果读的一方分不清
       * "没写"和"写了 A"——自己的测试就先绊了一跤。代价只是一个字段，
       * 换来"读 config 就知道到底谁先动"，值。
       */
      firstSeat,
      commanderMode,
      godMode: config.godMode === true,
      // 选卡模式要活进 config：读档/联机之后界面才知道"这一局有 BP"
      draftMode,
      // 两档选卡时限同样要活进 config：规则写 deadline 和界面倒计时都读这里。
      // 没填就不写字段，读出来自然回落 DRAFT_BAN_MS / DRAFT_PICK_MS 的默认值。
      ...(config.draftBanMs !== undefined ? { draftBanMs: config.draftBanMs } : {}),
      ...(config.draftPickMs !== undefined ? { draftPickMs: config.draftPickMs } : {}),
      // 逐回合摘要的开关必须活进 state.config：
      // 这个对象的字段是**逐个白名单抄的**，漏一个就等于那个开关在开局瞬间被吃掉。
      // 2026-10-28 就漏了这一个：玩家明明勾了"数据收集"，上传上来却没有摘要，
      // 因为 resetRecorder() 读到的是 undefined。
      recordDetail: config.recordDetail === true,
      /*
       * 脚本强制的战术（窄决策采集用）。产品界面不出这两个字段。
       *
       * 写在这里是因为这个对象是**逐个白名单抄的**——2026-11-06 漏过一次：
       * 加完字段没抄进来，`createMatch` 之后 `state.config.aiDoctrine` 是 undefined，
       * 三组"不同战术"跑出了完全相同的对局，白跑一批。
       * 没值时不写字段，读档老存档不会多出两个空键。
       */
      ...(config.aiDoctrine ? { aiDoctrine: config.aiDoctrine } : {}),
      ...(config.aiDoctrineSeat ? { aiDoctrineSeat: config.aiDoctrineSeat } : {}),
      /*
       * 关卡快照：整包进局面，不是只存 `level:id`。理由见 MatchConfig.level。
       *
       * 这一行绝对不能漏。这个对象是**逐个白名单抄的**，漏一个就等于那个开关在
       * 开局瞬间被吃掉：2026-10-28 漏过 recordDetail（勾了数据收集却没有摘要）、
       * 2026-11-06 漏过 aiDoctrine（三组"不同战术"跑出完全相同的对局）。
       * 关卡漏了比这两个都糟——它不会报错，也不会少一个功能，而是整局**退化成
       * 普通对局**，玩家只会觉得"这关怎么什么都没有"。
       */
      ...(checkedLevel && checkedLevel.ok ? { level: checkedLevel.level } : {}),
    },
    unitTypes,
    turn: 1,
    current: firstSeat,
    w,
    h,
    tiles,
    cities,
    units,
    // 四个席位都建出来（这一局没坐人的席位名字和金币留着也没人读：
    // 所有遍历都走 seatsOf，不会碰它们）。这样 `players[p]` 永远是定义好的。
    players: {
      A: { id: 'A', name: DEFAULT_PLAYER_NAMES.A, gold: startGoldFor(startEra) },
      B: { id: 'B', name: DEFAULT_PLAYER_NAMES.B, gold: seats.includes('B') ? startGoldFor(startEra) : 0 },
      C: { id: 'C', name: DEFAULT_PLAYER_NAMES.C, gold: seats.includes('C') ? startGoldFor(startEra) : 0 },
      D: { id: 'D', name: DEFAULT_PLAYER_NAMES.D, gold: seats.includes('D') ? startGoldFor(startEra) : 0 },
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
      C: { known: [] },
      D: { known: [] },
    },
  };

  /*
   * 关卡点名的开局兵（`LevelDef.deploy`）。
   *
   * 放在 state 建好之后做，因为"这一格站不站得住"要问规则层（`canStandAt`），
   * 而规则层要一整份 state。
   *
   * 两种摆不上去的情况都**跳过并写进战报**，不让整局建不起来：
   *   · 兵种这一局没有（关卡没把扩展写进 `require`，或者玩家禁用了那个兵）；
   *   · 这一格站不住（作者把兵写到水里、山里、或者跟城/别的兵叠上了）。
   * 静默跳过是最糟的选择——作者会以为"我明明写了"而查不出原因，所以战报里必须有一句。
   */
  for (const p of seats) {
    const list = levelDeploy[p];
    if (!list || list.length === 0) continue;
    for (const d of list) {
      const def = state.unitTypes[d.type];
      if (!def) {
        state.log.push({
          turn: 1,
          player: p,
          text: `关卡部署里的「${d.type}」这一局没有这个兵种，已跳过`,
        });
        continue;
      }
      if (!canStandAt(state, d.x, d.y, d.type)) {
        state.log.push({
          turn: 1,
          player: p,
          text: `关卡部署：${def.name} 在 (${d.x}, ${d.y}) 站不住，已跳过`,
        });
        continue;
      }
      state.units.push({
        id: `u${state.nextUnitSeq++}`,
        type: def.id,
        owner: p,
        x: d.x,
        y: d.y,
        hp: def.maxHp,
        kills: 0,
        moved: false,
        acted: false,
      });
    }
  }

  // 选卡模式：开局先打 BP。放在 state 建好之后——抽样要看 unitTypes 里的池子。
  if (draftMode) {
    state.draft = createDraft(state);
    state.log.push({
      turn: state.turn,
      player: 'A',
      open: true,
      text: `选卡模式：兵种池 ${state.draft.pool.length} 个，各禁 ${state.draft.banSlots} 个、各选 ${state.draft.pickSlots} 个`,
    });
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
    /*
     * 补偿发给**除了第一个行动者之外的所有人**。
     *
     * 两人局里就是 B——和以前一模一样。三人四人局里，第二个之后的每个人都有
     * "先手已经动过一轮"的劣势，所以都给同样的比例；先手那位一分不补。
     */
    for (const p of seats) {
      // 先手那位不补；其余每人补（两人局就是另一位）
      if (p === firstSeat) continue;
      const extra = Math.round(state.players[p].gold * bonusRatio);
      if (extra <= 0) continue;
      state.players[p].gold += extra;
      state.log.push({
        turn: 1,
        player: p,
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
  if (!config.noFirstIncome) grantOpeningIncome(state, firstSeat);

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
