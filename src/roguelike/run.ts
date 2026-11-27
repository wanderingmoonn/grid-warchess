/**
 * 一局肉鸽的纯逻辑：房间图生成、效果结算、跨层推进、敌人编成。
 *
 * 这里**不碰 DOM，也不碰规则层**——除了查一下兵种造价。
 * 好处是整套流程可以在 node 里直接跑（见 scripts/rogue-smoke.ts），
 * 不用开浏览器就能验证"十步走完 → boss → 下一层"这条链没有断。
 */
import {
  ALL_UNITS,
  DECISIONS,
  DEFENSE_BY_ERA,
  EVENTS,
  LAYERS,
  WORLD_DEFENSE,
  WORLDS,
  PLACE_NAMES,
  RELICS,
  REST_OPTIONS,
  STRATEGIES,
  TRIALS,
  packsForUnit,
  growthOf,
  CULTIVATORS,
  eventById,
  pickEnemyTypes,
  relicById,
  strategyById,
  unitName,
} from './data.ts';
import type { DecisionOption, LayerTheme, WorldId } from './data.ts';
import { expForRank } from '../core/cultivation/progression.ts';
import { makeRng } from './rng.ts';
import type { Rng } from './rng.ts';
import type {
  ArmyEntry,
  BattleInit,
  BattleResult,
  Buffs,
  Effect,
  EventDef,
  LayerId,
  LayerPlan,
  RewardOption,
  RoomKind,
  RoomNode,
  RunState,
  TrialDef,
} from './types.ts';

export const STEPS_PER_LAYER = 10;
export const ROOMS_PER_LAYER = STEPS_PER_LAYER * 2;

/**
 * 兵种造价表：直接用 `data.ts` 的全量索引（基础表 + 所有扩展包）。
 *
 * 上一版是 `...UNIT_TYPES` + 各层/各世界 `expansionUnitsFor(...)` 拼出来的子集，
 * 结果漏掉 `requiresPack` 的单位（圣剑勇者、邪龙王）：`costOf` 返回 0，
 * 商店标价 0、英雄唯一性失效、`unitDefOf` 也查不到。
 * 现在只有一个来源：`ALL_UNITS`（能不能上场由 `createMatch` 按 `expansionIds` 决定）。
 */
const CATALOG = ALL_UNITS;
const costOf = (id: string): number => CATALOG[id]?.cost ?? 0;

/**
 * 战后恢复的比例：活下来的人每打一场只回这么多血（占最大生命的比例）。
 *
 * 换层回满（见 `nextLayer`）——一层之内是"带着伤连着打"，一层结束才整补。
 * 定 0.4 的理由：大多数战斗结束时幸存者在 60%~90% 血，0.4 足够把他们拉回
 * 满血附近；只有"惨胜"（剩 20%~40%）才会把伤带进下一场。它惩罚的是硬拼，
 * 不是正常打法。
 */
export const HEAL_PER_BATTLE = 0.4;

/** 经验 → 境界（和引擎的 `expForRank` 用同一张表，别自己另立一套阈值） */
export function rankOfExp(exp: number): number {
  let r = 0;
  while (r < 9 && exp >= expForRank(r)) r += 1;
  return r;
}

/** 给界面层用：查一个兵种的完整定义（含扩展包） */
export function unitDefOf(type: string): import('../core/types.ts').UnitTypeDef | undefined {
  return CATALOG[type];
}

/**
 * 英雄：本体规则里**同一方场上只能有一个**，第一次招它还要付解锁费。
 *
 * 肉鸽没有"招募"这个动作（兵只从战利品/商店/事件来），所以这两条规则要
 * 在**获取**这一侧补上：
 *   · `addUnitCapped` 保证队伍里最多一位英雄；
 *   · `valueOf` 把解锁费算进它的"自身费用"，敌人编成与商店标价都用这个数，
 *     否则 470 造价的英雄会以 470 的价格买到一个价值 690 的单位。
 */
const isHero = (id: string): boolean => CATALOG[id]?.hero === true;
/** 给界面层用：这一件货是不是英雄（买了会占掉唯一的英雄名额） */
export const isHeroUnit = (id: string): boolean => isHero(id);
const heroUnlockOf = (id: string): number => (CATALOG[id]?.hero ? (CATALOG[id]?.unlockCost ?? 0) : 0);
/** 一个兵的"自身费用"：造价 +（英雄的）解锁费 */
const valueOf = (id: string): number => costOf(id) + heroUnlockOf(id);
const isAirUnit = (id: string): boolean => CATALOG[id]?.layer === 'air' || CATALOG[id]?.flight === true;
const armyHasHero = (army: ArmyEntry[]): boolean => army.some((a) => isHero(a.type));

/**
 * 金币价格水位（**按层**，第一层 = 1）。
 *
 * 事件/休整/决议里的钱原本是写死的（"−30 金""+90 金"），于是第一层用几十金
 * 买两个民兵、第三层还能用几十金买到重机枪组——同一个数字在两层的购买力
 * 差了一个数量级。这里按各层池子的中位造价定水位（35 / 150 / 380），
 * 取整成 1 / 4 / 9，所有"写死的钱"都乘它。
 *
 * 战利品与商店**不走这张表**：它们本来就按兵价算，乘上去会重复放大。
 */
export const PRICE_SCALE: Record<LayerId, number> = { 1: 1, 2: 4, 3: 9 };

export function priceScale(run: RunState): number {
  return PRICE_SCALE[run.layer] ?? 1;
}

/** 把"第一层的钱"换算成这一层的钱（取整到 10，避免出现 137 这种数） */
export function scaleGold(amount: number, run: RunState): number {
  const raw = amount * priceScale(run);
  return Math.sign(raw) * Math.round(Math.abs(raw) / 10) * 10;
}

/**
 * 数值藏品**按层成长**的步长（索引 = 层 - 1）。
 *
 * 为什么不是简单线性：伤害是 `atk - armor` 的减法，L1 中位攻 14、L3 中位攻 55，
 * 同样是 +1，第一层是 7%、第三层是 2%。而"移动 +1"是节奏收益，跟时代无关，
 * 于是越往后移速藏品越强。给攻/甲/血按层加码，是让三种加成**在同一层里等价**，
 * 不是让藏品滚雪球（每层只取一次，不叠乘）。
 */
const RELIC_GROWTH = {
  atk: [1, 2, 3],
  armor: [1, 2, 2],
  hp: [6, 9, 12],
} as const;

/** 藏品在这一层的实际数值文案（商店/奖励里显示用） */
export function relicDesc(id: string, layer: LayerId): string {
  const relic = relicById(id);
  if (!relic) return id;
  const i = Math.max(0, Math.min(2, layer - 1));
  if (relic.effect.atk) return `我军全体攻击 +${RELIC_GROWTH.atk[i]! * relic.effect.atk}`;
  if (relic.effect.armor) return `我军全体护甲 +${RELIC_GROWTH.armor[i]}`;
  if (relic.effect.hp) return `我军全体最大生命 +${RELIC_GROWTH.hp[i]}`;
  return relic.desc;
}

/**
 * 一条效果**实际**会进账/扣掉多少钱。
 *
 * 除了按层换算，还有一条上限：**买兵的选项不能比兵本身还贵**。
 *
 * 事件里写的是"−80 金，得 1 个高级兵"，到第三层 ×9 就是 720 金——而那个
 * "高级兵"在店里只卖 500 出头。层数越高，这种写死的钱越容易跟兵价脱钩，
 * 所以买兵的负金再夹一道 `0.9 × 自身费用 × 人数` 的上限。
 * 第一层基本不触发（作者写的本来就是那个价位的钱），第三层才会把它拉回来。
 */
export function effectiveGold(effect: Effect, run: RunState): number {
  const g = effect.gold ?? 0;
  if (g === 0) return 0;
  const scaled = scaleGold(g, run);
  if (g < 0 && effect.add) {
    const type = resolveType(themeOf(run), effect.add.type);
    const count = isHero(type) ? 1 : effect.add.count;
    const cap = Math.round((valueOf(type) * count * 0.9) / 10) * 10;
    return -Math.min(Math.abs(scaled), cap);
  }
  return scaled;
}

/**
 * 某一层、某一支史下的主题。
 *
 * 第二层是**四种样子**（正史 / 军备 / 奇想 / 修真），由 `run.world` 决定；
 * 第一层和第三层共用一套，第三层只把本世界的高代兵与扩展混进去
 * （修真没有 e5 兵，所以第三层对它是「末法之世」——不是缺内容，是设定）。
 */
export function themeFor(world: WorldId, layer: LayerId): LayerTheme {
  const def = WORLDS[world];
  if (layer === 2) return def.theme;
  if (layer !== 3) return LAYERS[layer];

  const extra = def.l3Pool;
  const expansions = [...new Set([...LAYERS[3].expansions, ...def.theme.expansions])];
  if (extra.length === 0 && !def.l3Subtitle && expansions.length === LAYERS[3].expansions.length) {
    return LAYERS[3];
  }
  return {
    ...LAYERS[3],
    subtitle: def.l3Subtitle ?? LAYERS[3].subtitle,
    expansions,
    pool: extra.length > 0 ? [...new Set([...extra, ...LAYERS[3].pool])] : LAYERS[3].pool,
  };
}

/** 当前这一局这一层的主题 */
export function themeOf(run: RunState): LayerTheme {
  return themeFor(run.world, run.layer);
}

export function emptyBuffs(): Buffs {
  return { atk: 0, armor: 0, hp: 0, move: 0, enemyCut: 0, cityDamage: 0, defenseDamage: 0, enemyHp: 0, tempUnits: 0 };
}

// ---------------------------------------------------------------- 军队

export function addUnits(army: ArmyEntry[], type: string, count: number): ArmyEntry[] {
  if (count <= 0) return army;
  const hit = army.find((a) => a.type === type);
  if (hit) hit.count += count;
  else army.push({ type, count });
  return army;
}

export function removeUnits(army: ArmyEntry[], type: string, count: number): void {
  const hit = army.find((a) => a.type === type);
  if (!hit) return;
  hit.count -= count;
  if (hit.count <= 0) army.splice(army.indexOf(hit), 1);
}

export function armyCount(army: ArmyEntry[]): number {
  return army.reduce((n, a) => n + a.count, 0);
}

export function armyCost(army: ArmyEntry[]): number {
  return army.reduce((n, a) => n + costOf(a.type) * a.count, 0);
}

/** string[] → ArmyEntry[]（同型号合并） */
function toArmy(types: string[]): ArmyEntry[] {
  const m = new Map<string, number>();
  for (const t of types) m.set(t, (m.get(t) ?? 0) + 1);
  return [...m.entries()].map(([type, count]) => ({ type, count }));
}

export function armyText(army: ArmyEntry[]): string {
  if (army.length === 0) return '（空）';
  return army.map((a) => `${unitName(a.type)}×${a.count}`).join('、');
}

/** 按造价排序后的池子（**不含英雄**：奖励、整编、事件都不能白送英雄） */
function byPrice(pool: readonly string[]): string[] {
  return [...pool].filter((id) => !isHero(id)).sort((a, b) => costOf(a) - costOf(b));
}

function cheapestOf(theme: LayerTheme): string {
  return byPrice(theme.pool)[0] as string;
}

function midOf(theme: LayerTheme): string {
  const sorted = byPrice(theme.pool);
  return sorted[Math.floor(sorted.length / 2)] as string;
}

function highOf(theme: LayerTheme): string {
  const sorted = byPrice([...theme.pool, ...theme.poolHigh]);
  return sorted[sorted.length - 1] as string;
}

// ---------------------------------------------------------------- 房间图

const BAG: RoomKind[] = [
  // 6 普通 + 2 精英 + 1 攻坚 + 1 守城 = 10 场，和 FLOW 的「6:2:2」对齐
  //（设计里的两个"特殊"= 一场攻坚 + 一场守城）
  ...Array<RoomKind>(6).fill('battle'),
  ...Array<RoomKind>(2).fill('elite'),
  ...Array<RoomKind>(1).fill('siege'),
  // 守城战：一层一场，位置随机。它是一层里唯一"你守别人"的仗
  ...Array<RoomKind>(1).fill('special'),
  ...Array<RoomKind>(4).fill('event'),
  ...Array<RoomKind>(2).fill('shop'),
  ...Array<RoomKind>(4).fill('rest'),
];

/**
 * 生成一层的 10 步 × 2 门。
 *
 * 固定几个"锚点"，其余随机：
 *   · 第 1 步两扇门都是战斗（入场必战，选从哪边杀进来）；
 *   · 第 3、7 步各有一扇商店门（保证一局至少逛两次店）；
 *   · 第 4、8 步各有一扇休整门（保证喘得上气）。
 */
/**
 * 第一层的两个"史线钩子"。
 *
 * 只在一层用：一个试炼（替换一场普通战斗）+ 一条史线事件（排在第一个事件房）。
 * 二三层不传，房间图与以前完全一样。
 */
export interface LayerHooks {
  /** 史线事件 id：保证它出现在这一层的第一个事件房 */
  storyEventId?: string;
  /** 史线试炼：替换第 2 步的一扇门（很近，玩家早期就能决定打不打） */
  trial?: TrialDef;
}

export function planLayer(
  layer: LayerId,
  rng: Rng,
  theme: LayerTheme = LAYERS[layer],
  hooks: LayerHooks = {},
): LayerPlan {
  const slots: Array<RoomKind | null> = Array<RoomKind | null>(ROOMS_PER_LAYER).fill(null);
  const at = (step: number, door: number): number => step * 2 + door;

  slots[at(0, 0)] = 'battle';
  slots[at(0, 1)] = 'battle';
  slots[at(2, rng.int(2))] = 'shop';
  slots[at(6, rng.int(2))] = 'shop';
  slots[at(3, rng.int(2))] = 'rest';
  slots[at(7, rng.int(2))] = 'rest';
  /*
   * 试炼放在第 2 步的左门：第 1 步是两场普通战斗（让玩家先摸一下这层的强度），
   * 第 2 步就能看见"要不要打这一仗换一条历史"。右门仍是普通战斗，可以绕开。
   */
  if (hooks.trial) slots[at(1, 0)] = 'trial';

  const bag: RoomKind[] = [];
  const need: Record<string, number> = {};
  for (const k of BAG) need[k] = (need[k] ?? 0) + 1;
  for (const k of slots) if (k) need[k] = (need[k] ?? 0) - 1;
  for (const [k, n] of Object.entries(need)) for (let i = 0; i < n; i += 1) bag.push(k as RoomKind);
  rng.shuffle(bag);
  // 试炼顶掉一场普通战斗：战斗总数仍是 10（6 普通变 5 普通 + 1 试炼），比例不乱
  if (hooks.trial) {
    const i = bag.indexOf('battle');
    if (i >= 0) bag.splice(i, 1);
  }

  for (let i = 0; i < slots.length; i += 1) if (!slots[i]) slots[i] = bag.pop() ?? 'battle';

  let eventPool = rng.shuffle([...EVENTS]);
  /*
   * 史线事件排到第一个事件房：一局一层，玩家至少有一次"要不要为某支史站队"的
   * 机会。它不额外多给一个事件房，只是把池子里那条提到队首。
   */
  if (hooks.storyEventId) {
    const story = eventPool.find((e) => e.id === hooks.storyEventId);
    if (story) eventPool = [story, ...eventPool.filter((e) => e !== story)];
  }
  let eventCursor = 0;

  const steps: RoomNode[][] = [];
  for (let step = 0; step < STEPS_PER_LAYER; step += 1) {
    const doors: RoomNode[] = [];
    for (let door = 0; door < 2; door += 1) {
      const kind = slots[at(step, door)] as RoomKind;
      doors.push(
        makeRoom(kind, layer, theme, rng, () => {
          const def = eventPool[eventCursor % eventPool.length] as EventDef;
          eventCursor += 1;
          return def.id;
        }, hooks.trial),
      );
    }
    steps.push(doors);
  }
  return { steps };
}

/** 守城战的三家东家：平时是你的对手，这一次他们需要你 */
const SPECIAL_FACTIONS = ['守墙人', '持秤者', '守钟人'] as const;

/**
 * 守城战的东家与报酬。
 *
 * 报酬兵取**本层最高档**（`poolHigh` 里最贵的三个之一，按东家分），
 * 所以它一定是"这一层平时拿不到、拿到了很值"的那种。修真的法器、奇想的
 * 巨兽都会从这里出来。
 */
function specialOf(theme: LayerTheme, rng: Rng): NonNullable<RoomNode['special']> {
  const faction = rng.int(SPECIAL_FACTIONS.length);
  const high = byPrice(theme.poolHigh);
  const unit = high[Math.max(0, high.length - 1 - faction)] ?? high[high.length - 1] ?? cheapestOf(theme);
  return { faction, name: SPECIAL_FACTIONS[faction] as string, unit };
}

function makeRoom(
  kind: RoomKind,
  layer: LayerId,
  theme: LayerTheme,
  rng: Rng,
  nextEvent: () => string,
  trial?: TrialDef,
): RoomNode {
  const place = rng.pick(PLACE_NAMES[layer]);
  switch (kind) {
    case 'battle':
      return { kind, title: '遭遇战', sub: `${place} · 无人据守的野地` };
    case 'elite':
      return { kind, title: '精英战', sub: `${place} · 对方在塔下扎住了` };
    case 'siege':
      return { kind, title: '攻坚战', sub: `${place} · 城在对面手里` };
    case 'special': {
      const sp = specialOf(theme, rng);
      return { kind, title: '守城战', sub: `${place} · 帮${sp.name}守一段`, special: sp };
    }
    case 'trial': {
      const t = trial ?? (TRIALS[0] as TrialDef);
      return { kind, title: t.title, sub: t.sub, trial: t };
    }
    case 'event':
      return { kind, title: '事件', sub: `${place} · 有人等你说话`, eventId: nextEvent() };
    case 'shop':
      return { kind, title: '行商', sub: `${place} · 摊子支在路边` };
    case 'rest':
      return { kind, title: '营地', sub: `${place} · 今晚不开战` };
    default:
      return { kind: 'boss', title: '层末会战', sub: '挡在路上的最后一道' };
  }
}

// ---------------------------------------------------------------- 开局

export function startRun(seed: number, strategyId: string): RunState {
  const strategy = strategyById(strategyId);
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);
  const army = strategy.army.map((a) => ({ ...a }));
  /*
   * 第一层的两个史线钩子：一局抽**一个试炼** + **一条史线事件**。
   *
   * 试炼池是奇想/修真，事件池是军备——三条支线各有入口，正史则留给
   * "两个都没碰"的人。注意这里只抽"这一层会遇到哪一条"，不是"你要哪一支"：
   * 想走哪支，得看路上敢不敢打、肯不肯站队。
   */
  const stories = EVENTS.filter((e) => e.story);
  const story = stories.length > 0 ? stories[rng.int(stories.length)] : undefined;
  const trial = TRIALS[rng.int(TRIALS.length)] as TrialDef;
  return {
    seed,
    strategyId,
    world: 'base',
    worldLock: null,
    worldBan: [],
    layer: 1,
    step: 0,
    gold: strategy.gold ?? 180,
    army,
    relics: [],
    plan: planLayer(1, rng, themeFor('base', 1), { storyEventId: story?.id, trial }),
    clock: 0,
    buffs: emptyBuffs(),
    bossDone: false,
    // 修为与伤都不跨层：修为留着（跨战斗），伤在换层时回满
    cultivation: {},
    wounds: {},
    reviveLeft: 0,
    log: [`开局：${strategy.name}，${armyText(army)}`],
    over: null,
  };
}

// ---------------------------------------------------------------- 效果

/**
 * 从队伍里扣人：`layer-*` 按**你手上**的贵贱扣，而不是按这一层池子的贵贱。
 *
 * 事件写"损 1 个基础兵"，玩家队伍里未必正好有这一层最便宜的那个（开局是戈兵，
 * 不是民兵）。按池子查会一个都扣不掉，事件就成了空话。所以：
 * 低 = 你手上最便宜的，高 = 最贵的，中 = 中间那档。
 */
function removeTier(run: RunState, tier: string, count: number): { lost: number; name: string } {
  let lost = 0;
  let name = '';
  for (let i = 0; i < count; i += 1) {
    const list = [...run.army].filter((a) => a.count > 0).sort((a, b) => costOf(a.type) - costOf(b.type));
    if (list.length === 0) break;
    const entry =
      tier === 'layer-low'
        ? list[0]
        : tier === 'layer-high'
          ? list[list.length - 1]
          : list[Math.floor(list.length / 2)];
    if (!entry) break;
    removeUnits(run.army, entry.type, 1);
    name = unitName(entry.type);
    lost += 1;
  }
  return { lost, name };
}

/** 把 layer-low / layer-mid / layer-high 解析成具体兵种 */
function resolveType(theme: LayerTheme, type: string): string {
  if (type === 'layer-low') return cheapestOf(theme);
  if (type === 'layer-mid') return midOf(theme);
  if (type === 'layer-high') return highOf(theme);
  return type;
}

/**
 * 应用一条效果。`random` / `risk` 类的东西在这里落地，所以需要 rng。
 *
 * `log` 只给递归用：赌博的两岔会再进来一次，内层不要再往行记里写一遍，
 * 否则同一次结算在界面上出现两遍。
 */
function applyEffectInner(
  run: RunState,
  effect: Effect,
  rng: Rng,
  log: boolean,
  opts: { scaleGold: boolean },
): string[] {
  const notes: string[] = [];
  const theme = themeOf(run);

  if (typeof effect.gold === 'number' && effect.gold !== 0) {
    /*
     * 事件/休整里写死的钱是"第一层的钱"，按层的水位换算之后再进账。
     * 战利品、商店、决议不走这条路（它们已经按兵价算好了），见 `applyEffect` 的 opts。
     */
    const amount = opts.scaleGold ? effectiveGold(effect, run) : effect.gold;
    run.gold = Math.max(0, run.gold + amount);
    notes.push(`${amount > 0 ? '+' : ''}${amount} 金`);
  }
  if (typeof effect.nextAtk === 'number' && effect.nextAtk !== 0) {
    run.buffs.atk += effect.nextAtk;
    notes.push(`下一战攻击 ${effect.nextAtk > 0 ? '+' : ''}${effect.nextAtk}`);
  }
  if (typeof effect.nextArmor === 'number' && effect.nextArmor !== 0) {
    run.buffs.armor += effect.nextArmor;
    notes.push(`下一战护甲 +${effect.nextArmor}`);
  }
  if (typeof effect.nextHp === 'number' && effect.nextHp !== 0) {
    run.buffs.hp += effect.nextHp;
    notes.push(`下一战生命 +${effect.nextHp}`);
  }
  if (effect.add) {
    const type = resolveType(theme, effect.add.type);
    /*
     * 英雄**发不出第二个**：本体的规则是"同一方场上只能有一个"，
     * 而肉鸽的兵是白给的（战利品/事件），不在这里拦就会攒出两个英雄。
     * 已经有一位时，这一项改成一句说明，不静默吞掉。
     */
    if (isHero(type) && armyHasHero(run.army)) {
      notes.push(`队伍里只能有一位英雄，${unitName(type)} 没跟上来`);
    } else {
      const n = isHero(type) ? 1 : effect.add.count;
      addUnits(run.army, type, n);
      notes.push(`${unitName(type)} ×${n}${isHero(type) ? '（英雄）' : ''}`);
    }
  }
  if (effect.remove) {
    if (effect.remove.type.startsWith('layer-')) {
      const r = removeTier(run, effect.remove.type, effect.remove.count);
      notes.push(r.lost > 0 ? `−${r.lost} ${r.name}` : '没有人可以减');
    } else {
      const before = armyCount(run.army);
      removeUnits(run.army, effect.remove.type, effect.remove.count);
      const lost = before - armyCount(run.army);
      notes.push(lost > 0 ? `−${lost} ${unitName(effect.remove.type)}` : '没有人可以减');
    }
  }
  /*
   * ---- 史线：锁定 / 排斥 / 按钟给兵 ----
   *
   * 锁定优先于排斥：已经为某支史投入过的路，不能被一句"我不喜欢"否掉。
   * 锁定一支 = 同时排斥另外三支（`worldLock` 一有值，其它钩子全部失效），
   * 所以这里只记一个值；`worldBan` 只服务"还没定路时先把某支划掉"。
   */
  if (effect.world?.lock) {
    const id = effect.world.lock;
    if (run.worldLock && run.worldLock !== id) {
      notes.push(`路已经定了：${WORLDS[run.worldLock].name}`);
    } else {
      run.worldLock = id;
      run.worldBan = run.worldBan.filter((w) => w !== id);
      notes.push(`第二层：${WORLDS[id].name}（路已定）`);
    }
  }
  if (effect.world?.ban) {
    const id = effect.world.ban;
    if (run.worldLock === id) {
      notes.push(`已经走上${WORLDS[id].name}，改不了了`);
    } else if (!run.worldBan.includes(id)) {
      run.worldBan.push(id);
      notes.push(`第二层不再进入${WORLDS[id].name}`);
    }
  }
  if (effect.addByClock) {
    const w = effect.addByClock.world;
    const t = WORLDS[w].theme;
    // 钟越靠后越可能给高代：钟 0 = 全低代，钟 10 = 全高代
    const high = Math.min(1, Math.max(0, run.clock / STEPS_PER_LAYER));
    const type = rng.pick(byPrice(rng.next() < high ? t.poolHigh : t.pool));
    const n = effect.addByClock.count;
    addUnits(run.army, type, n);
    notes.push(`${unitName(type)} ×${n}`);
  }
  if (effect.relic) {
    const owned = new Set(run.relics);
    const id =
      effect.relic === 'random'
        ? (RELICS.filter((r) => !owned.has(r.id))[0]?.id ?? rng.pick(RELICS).id)
        : effect.relic;
    if (!owned.has(id) && relicById(id)) {
      run.relics.push(id);
      // 随军医官是"每层 2 个额度"，拿到的那一刻就开额度
      if (id === 'medic') run.reviveLeft = 2;
      notes.push(`藏品「${relicById(id)?.name ?? id}」`);
    } else {
      run.gold += 60;
      notes.push('重复的藏品折成 +60 金');
    }
  }
  /*
   * 整编：把最低级的兵换成**本层最高档**。
   *
   * 这是"换代"最直接的一条路——不换装之后，玩家需要某个东西把老兵换成新兵，
   * 否则 L1 带上来的戈兵会一直占着编制。一次只换一个人，换不起就说清楚。
   */
  if (effect.promote) {
    let done = 0;
    let last = '';
    for (let i = 0; i < effect.promote; i += 1) {
      const sorted = [...run.army].filter((a) => a.count > 0).sort((a, b) => costOf(a.type) - costOf(b.type));
      const low = sorted[0];
      if (!low) break;
      /*
       * 换到**高一档里最便宜的那个**，不是全层最贵的。
       * 后者会让"整编"一次跳到 boss 级单位（奇想层直接给一个神圣骑士长），
       * 那不是整编，是空投。
       */
      const target = byPrice(theme.poolHigh).find((id) => costOf(id) > costOf(low.type));
      if (!target) break;
      removeUnits(run.army, low.type, 1);
      addUnits(run.army, target, 1);
      last = unitName(target);
      done += 1;
    }
    notes.push(done > 0 ? `整编 ${done} 人（换成${last}）` : '编制已经到顶，没什么可换的');
  }
  /*
   * 赌一把：先结算确定的部分（上供的钱已经扣了），再抽这一下。
   * 抽中与没抽中的文案都写进 notes——玩家得看见自己输在哪。
   */
  if (effect.risk) {
    const hit = rng.next() < effect.risk.chance;
    notes.push(hit ? effect.risk.winText : effect.risk.loseText);
    const branch = hit ? effect.risk.win : effect.risk.lose;
    if (branch) notes.push(...applyEffectInner(run, branch, rng, false, opts));
  }
  if (log) for (const n of notes) run.log.push(n);
  return notes;
}

/**
 * 对外的入口：结算一条效果，并写进行记。
 *
 * `opts.scaleGold`：这条效果里的钱是"第一层的钱"还是"已经算好的钱"。
 *   · 事件选项 → true（数据里写的是 −30 / +70 这种基准值）
 *   · 休整 / 决议 / 战利品 / 商店 → false（它们在生成时已经按当前层算过）
 */
export function applyEffect(
  run: RunState,
  effect: Effect,
  rng: Rng,
  opts: { scaleGold?: boolean } = {},
): string[] {
  return applyEffectInner(run, effect, rng, true, { scaleGold: opts.scaleGold === true });
}

/** 房间走完：步数与时代钟一起涨 */
export function afterRoom(run: RunState): void {
  run.step = Math.min(STEPS_PER_LAYER, run.step + 1);
  run.clock = Math.min(STEPS_PER_LAYER, run.clock + 1);
}

// ---------------------------------------------------------------- 战斗输入

/**
 * 平衡参数（**调参入口**）。
 *
 * 敌人有多强，**主要看层，不看我方部队**：
 *   base[layer] —— 这一层的敌人基准价值（遭遇战、刚进门）
 *   w[kind]     —— 房型倍率（精英/攻坚/层末更贵）
 *   ramp        —— 层内进度：刚进门 ×ramp，走到底接近 1.15
 *   expect[layer] / follow —— 我方部队相对"这一层该有的样子"的偏离，
 *                              只按 25% 反映到敌人身上
 *
 * 为什么不再用"敌人 = 你的镜像"（纯按我方造价乘 k）：
 * 实测那条线会滑向一个坏平衡——**兵越少越强**。因为小地图上同一时间只有
 * 三四个兵能交手，多出来的兵挤在后面挨打；而敌人预算跟着你的总造价涨，
 * 于是"拿兵"反而让对面也变强，通关率比"拿钱"低一截（实测 0/18 vs 8/18）。
 * 现在：层决定对面有多强，你的成长只带来 25% 的回响。
 */
export const BALANCE = {
  /** 敌人人数 = 我方人数 × 这个系数（再夹在 2~我方-1 之间） */
  countFollow: 0.7,
  /** 每深一层，人数下限 +1（一层的遭遇战至少 3 个，三层至少 5 个） */
  countBase: { battle: 3, elite: 3, siege: 3, special: 3, boss: 4 } as Record<string, number>,
  /**
   * **我方的钱折成敌军人头的系数**（1 = 一个最便宜的兵的价格算一个人头）。
   *
   * 0.1 = **十个最便宜的兵的钱，才抵一个敌人**。为什么不设 0：
   * 敌方只跟"人数"走的话，"开局不拿兵、纯屯钱买藏品、后期再补兵"是严格最优
   * ——你越空，对面越弱。给钱一个低权重，屯钱仍然要付代价，但不会把
   * "攒钱买藏品"这条玩法打死（那本来是本作的主要乐趣之一）。
   *
   * 取整用 floor，所以开局那 180 金不会立刻多一个敌人（0.72 → 0），
   * 也避免"多 1 金就涨一个人"的悬崖。
   */
  goldFollow: 0.1,
  /**
   * "加钱"的系数（按房型）：底钱只够买池里最便宜的兵，这一笔决定能往上抬多少。
   * 调大 = 敌人更精锐（同人数、更好的兵）；调小 = 更多便宜兵。
   */
  quality: { battle: 0.54, elite: 0.63, siege: 0.6, special: 0.58, boss: 0.69 } as Record<string, number>,
  /** 层内进度：刚进门 ×ramp，走到底接近 1.15 */
  ramp: 0.75,
  rampStep: 0.04,
  /**
   * 每层的"预算系数"。
   *
   * 三层分开调，是因为同一套人数公式在三个价位上感受完全不同：
   * 一代兵 25~50 一档，五代兵 215~400 一档，同一把尺子量不出同样的手感。
   * 这一列也是**整体难度旋钮**——想更简单就整体往上抬。
   */
  layerPower: { 1: 0.7, 2: 0.7, 3: 0.72 } as Record<number, number>,
};

/**
 * 敌人这一场有多少钱：**人数 × 池子均价 × 房型系数**。
 *
 * 为什么不再用"每层一个基准价"：那个写法里，钱和人数是分开定的，预算不够时
 * `pickEnemyTypes` 只能少买几个——玩家攒到十个兵的时候，场上就变成"十打三"。
 * 现在先定人数（跟着玩家走），再把钱按人头摊下去，**人数一定凑得齐**，
 * 每个敌人也因此自动落在"这一层该有的价位"上。
 *
 * 顺带保住了一条重要的激励：钱只跟**人数**走，不跟**兵的质量**走。
 * 所以"把兵换成更高代"是纯收益，不会让对面跟着变强。
 */
function enemyScale(
  layer: LayerId,
  kind: RoomKind,
  count: number,
  pool: string[],
  clock: number,
  worldPower: number,
): { budget: number; gold: number } {
  const ramp = BALANCE.ramp + BALANCE.rampStep * Math.min(STEPS_PER_LAYER, clock);
  /*
   * 用**池子里最便宜的那个**当尺子，而不是均价。
   *
   * 均价当尺子的毛病：均价被几个贵兵拉高，钱不够时只买得起最便宜的，
   * 于是"算出来 6 个、场上只出现 3 个"。用最低价 ×1.35 保证每个位置
   * 都买得起人，**人数一定凑得齐**，贵的兵靠"第一个位置拿一半预算"去买。
   */
  const costs = pool.map(valueOf).filter((n) => n > 0);
  const cheapest = Math.min(...costs);
  const avg = costs.reduce((n, c) => n + c, 0) / Math.max(1, costs.length);
  const q = BALANCE.quality[kind] ?? 0.9;
  const layerK = BALANCE.layerPower[layer] ?? 0.8;
  /*
   * 钱分两笔：
   *   **底钱** = 人数 × 池内最低价 —— 保证每个位置都买得起人，人数一定凑齐；
   *   **加钱** = 人数 ×（均价 − 最低价）× 系数 —— 有钱才往上升级，
   *              没钱就是一群便宜兵。
   * 上一版把系数乘在全部预算上，人数跟着缩水，"算 6 个、来 3 个"。
   */
  const base = count * cheapest;
  const extra = count * Math.max(0, avg - cheapest) * q * ramp * worldPower * layerK;
  const budget = Math.max(40, Math.round(base + extra));
  return { budget, gold: Math.round(budget * 0.2) };
}

/**
 * 敌人这一场上几个人：按我方人数乘 0.7，加一个按层抬高的下限，
 * 但**永远比我方少一个以上**。
 */
function enemyHeadcount(kind: RoomKind, layer: LayerId, myCount: number): number {
  const floor = (BALANCE.countBase[kind] ?? 3) + (layer - 1);
  const follow = Math.round(myCount * BALANCE.countFollow);
  return Math.max(2, Math.min(Math.max(floor, follow), myCount - 1));
}

/** 藏品 + 方略 + 攒下的一次性加成，合成这一场的我军加成 */
export function bonusOf(run: RunState): {
  atk: number;
  armor: number;
  hp: number;
  move: number;
  moveSlow: number;
  enemyCut: number;
  cityDamage: number;
  defenseDamage: number;
  enemyHp: number;
  tempUnits: number;
} {
  let atk = 0;
  let armor = 0;
  let hp = 0;
  let move = 0;
  let moveSlow = 0;
  let enemyCut = 0;
  let cityDamage = 0;
  let defenseDamage = 0;
  let enemyHp = 0;
  for (const id of run.relics) {
    const e = relicById(id)?.effect;
    if (!e) continue;
    const i = Math.max(0, Math.min(2, run.layer - 1));
    atk += (e.atk ?? 0) * RELIC_GROWTH.atk[i]!;
    armor += (e.armor ?? 0) * RELIC_GROWTH.armor[i]!;
    hp += (e.hp ?? 0) * (RELIC_GROWTH.hp[i]! / 6);
    moveSlow += e.move ?? 0;
    enemyCut += e.enemyCut ?? 0;
    cityDamage += e.cityDamage ?? 0;
  }
  if (run.strategyId === 'frontier') armor += 1;
  if (run.strategyId === 'horse') move += 1;
  atk += run.buffs.atk;
  armor += run.buffs.armor;
  hp += run.buffs.hp;
  enemyCut += run.buffs.enemyCut;
  cityDamage += run.buffs.cityDamage;
  defenseDamage += run.buffs.defenseDamage;
  enemyHp += run.buffs.enemyHp;
  move += run.buffs.move;
  return {
    atk,
    armor,
    hp,
    move,
    moveSlow,
    enemyCut,
    cityDamage,
    defenseDamage,
    enemyHp,
    tempUnits: run.buffs.tempUnits,
  };
}

/** 这一层的防御工事（第二层按世界换外壳，其余按时代） */
export function defenseFor(run: RunState): import('./data.ts').DefenseSet {
  if (run.layer === 2) {
    const w = WORLD_DEFENSE[run.world];
    if (w) return w;
  }
  const theme = themeOf(run);
  return DEFENSE_BY_ERA[theme.eraLow] ?? (DEFENSE_BY_ERA[3] as import('./data.ts').DefenseSet);
}

/**
 * 飞行单位的两条**编成**约束（不是禁用）。
 *
 * 规则层对空中目标只多算一格距离（`strikeDistance`），所以有射程的兵照样能
 * 打下来；但纯近战的队伍确实碰不到它——那种局会拖到回合上限，两边都难受。
 * 因此：
 *   · 一场最多留**一个**飞行单位（编成里还有地面兵，仗总能打完）；
 *   · 我方没有任何射程 ≥2 的兵时，一个都不留。
 * 被换掉的按"造价最接近的地面兵"顶替，人数与预算都不变。
 */
function sanitizeAir(types: string[], run: RunState, theme: LayerTheme): string[] {
  const airSlots = types.map((t, i) => (isAirUnit(t) ? i : -1)).filter((i) => i >= 0);
  if (airSlots.length === 0) return types;
  const hasRanged = run.army.some((a) => (CATALOG[a.type]?.range ?? 1) >= 2);
  const ground = byPrice([...theme.pool, ...theme.poolHigh].filter((id) => !isAirUnit(id)));
  if (ground.length === 0) return types;
  const nearestGround = (value: number): string => {
    let best = ground[0] as string;
    let gap = Infinity;
    for (const id of ground) {
      const g = Math.abs(costOf(id) - value);
      if (g < gap) {
        gap = g;
        best = id;
      }
    }
    return best;
  };
  const keep = hasRanged ? airSlots[0] : -1;
  return types.map((t, i) => (i === keep || !isAirUnit(t) ? t : nearestGround(costOf(t))));
}

export function battleFor(run: RunState, node: RoomNode, seed: number): BattleInit {
  const theme = themeOf(run);
  const isBoss = node.kind === 'boss';
  const isSpecial = node.kind === 'special';
  const isTrial = node.kind === 'trial' && !!node.trial;
  const myCount = armyCount(run.army);
  const strat = strategyById(run.strategyId);
  const idx = isBoss ? 3 : node.kind === 'siege' ? 2 : node.kind === 'elite' ? 1 : 0;
  /*
   * 敌人池按时代钟分三段（不再是"当代 / 高代"两段）：
   *   ① 钟 0–2：**整段用上一代**（L2 是 e2、L3 是 e4）。玩家带着上一层的兵上来，
   *      这三关就是留给他"用老兵打完最后几仗"的，不该第一间房就撞当代兵。
   *   ② 钟 3–5：本层低代。
   *   ③ 钟 6 以后 / 层末：2 份高代 + 1 份低代（`pickEnemyTypes` 先买贵的，
   *      于是编成是"几个当代尖子 + 一群上一代兜底"）。
   * 层末固定高代（boss 不读钟，这条在 FLOW 里写过）。
   */
  const stage: 0 | 1 | 2 = isBoss ? 2 : run.clock <= 2 ? 0 : run.clock <= 5 ? 1 : 2;
  /*
   * 试炼是"从目标世界借来的少量当代兵"：不管本层钟走到哪，他们就是 e3——
   * 这是一支不属于这条时间线的队伍，所以固定代次，也别让钟把他们涨成 e4。
   */
  const era = isTrial
    ? 3
    : stage === 0
      ? theme.prevPool.length > 0
        ? theme.prevEra
        : theme.eraLow
      : stage === 1
        ? theme.eraLow
        : theme.eraHigh;
  const pool =
    stage === 0
      ? theme.prevPool.length > 0
        ? theme.prevPool
        : theme.pool
      : stage === 1
        ? [...theme.pool, ...theme.prevPool]
        : [...theme.poolHigh, ...theme.poolHigh, ...theme.pool, ...theme.prevPool];

  const def = defenseFor(run);
  /** 敌方的工事：精英一座塔；攻坚一座塔；层末两座塔 */
  const enemyDefense: ArmyEntry[] = [];
  if (node.kind === 'elite') {
    // 精英战的"据点"就是一座塔 + 围着它的兵；墙只会把地图堵死，这里不放
    enemyDefense.push({ type: def.tower, count: 1 });
  } else if (node.kind === 'siege') {
    // 攻坚只有一座塔：这一关的题面是"啃城"，不是"啃要塞"
    enemyDefense.push({ type: def.tower, count: 1 });
  } else if (isBoss) {
    /*
     * 层末的工事按层加。
     *
     * 第一/二层：一座塔 + 一道墙（新手第一次见 boss 不该被交叉火力按住）。
     * 第三层：**两座城各一套**——以前只给两座塔、而且全堆在第一座城边上，
     * 第二座城光秃秃的，看起来不像"钟楼"，像一座空营。现在工事翻到四件
     * （2 塔 + 2 墙），由 `battle.ts` 按城均分。
     */
    if (run.layer >= 3) {
      enemyDefense.push({ type: def.tower, count: 2 });
      if (def.wall) enemyDefense.push({ type: def.wall, count: 2 });
    } else {
      enemyDefense.push({ type: def.tower, count: 1 });
      if (def.wall) enemyDefense.push({ type: def.wall, count: 1 });
    }
  }

  /*
   * ---- 这一场敌方有多少人 ----
   *
   * 两个维度一起决定：
   *   1. **我方的兵**：×0.7，仍然比我方少一个以上；
   *   2. **我方的钱**：按"池内最低价兵"折成虚拟人头，系数 `goldFollow = 0.15`。
   *      钱的 k 比兵低一个数量级，但必须算——不然"开局不拿兵、纯屯钱买藏品、
   *      后期再补兵"就是最优解：对面只跟着你的**人数**走，你越空它越弱。
   * 钱只进编成，不进地图尺寸（图是按真人头长的）。
   */
  const cheapest = byPrice(theme.pool)[0] as string;
  const goldHeads = Math.floor(
    (Math.max(0, run.gold) / Math.max(1, costOf(cheapest))) * BALANCE.goldFollow,
  );

  /*
   * 防御工事**换编制**：每两件工事多一个守军（至少 +1）。
   *
   * 攻方先手，守方本来就吃亏；上一版工事还要按半价吃守军的预算，等于
   * "多两座塔 = 少一个兵"。现在工事只按 1/4 价占预算，并且**倒过来补人**：
   * a 个兵 b 座塔 → a + ⌈b/2⌉ 个兵 b 座塔。
   */
  const structures = enemyDefense.reduce((n, d) => n + d.count, 0);
  const defenseCrew = structures > 0 ? Math.max(1, Math.ceil(structures / 2)) : 0;
  const headcount =
    enemyHeadcount(node.kind, run.layer, myCount) + goldHeads + defenseCrew + (strat.enemyBonus ?? 0);

  /*
   * 地图要跟人数一起长。
   *
   * 8×8 上站 6 个人是遭遇战，站 20 个人就是堵车——后排一辈子挤不上去，
   * 攻坚还会因为走不到城下被判超时。人多的时候把图放大一点，
   * 但只放大到 22（再大就变成"跑半天才见面"）。
   */
  const crowd = Math.max(0, Math.floor((myCount + headcount - 8) / 3));
  // 试炼用固定小图（10×10）：对面只有两个人，大地图会变成"跑半天才见面"
  const size = isTrial
    ? 10
    : Math.min(22, (theme.size[idx] as number) + Math.min(4, crowd) + (isSpecial ? 2 : 0));

  // 遭遇/精英：双方无城；攻坚 1 座；层末 L1–L2 一座、L3 两座；守城战是"玩家有城"
  const enemyCityCount: 0 | 1 | 2 = node.kind === 'siege' ? 1 : isBoss ? (run.layer >= 3 ? 2 : 1) : 0;

  const clockForScale = isBoss ? STEPS_PER_LAYER : run.clock;
  /*
   * 世界难度 × 试验型方略的补偿系数。
   *
   * 试验队带着四代枪、英雄队带着一个 470 造价的英雄进第一层——不给对面
   * 加派点人手，这两条就是"点一下就赢"，试不出任何手感。
   */
  const power = (WORLDS[run.world].power ?? 1) * (strat.power ?? 1);
  const scale = enemyScale(run.layer, node.kind, headcount, pool, clockForScale, power);

  /*
   * 守城战：三波。
   *
   * 第一波就在场上（`enemyTypes`），后面两波在第 3 / 第 6 轮到场。波次
   * 不是"随机刷怪"，是同一支攻军的梯队：先到的少、后到的多，最后压上主力。
   * 人数按正常遭遇战的 0.5 / 0.35 / 0.35 分，总兵力比一场遭遇战多两成——
   * 但你有一座城和一处工事，这是"守"的本钱。
   */
  /*
   * 工事只按**造价 1/4** 占预算（上一版是 1/2）。
   *
   * 守方没有先手：塔和墙不能走位、吃不到地形、也换不了目标，值不了全价。
   * 而且它们本来就已经通过 `defenseCrew` 换成了编制——再按半价挤兵，
   * 就是"造塔反而更弱"。1/4 这个数配合"每两件 +1 兵"，让 a 兵 b 塔
   * 稳定变成 a+⌈b/2⌉ 兵 b 塔，而不是 a−1 兵 b 塔。
   */
  const defValue = Math.min(
    scale.budget * 0.35,
    enemyDefense.reduce((n, d) => n + (costOf(d.type) || 0) * d.count * 0.25, 0),
  );
  const troopBudget = Math.max(40, scale.budget - defValue);
  /*
   * 人数**不因工事缩水**（2026-11-25 改）。
   *
   * 上一版按"剩下的钱占原预算的比例"折人数：L3 层末四件工事吃掉 35% 预算，
   * 五个守军就变成三个——玩家走上去看见的是"两座城、四件工事、四个兵"，
   * 既不像会战，也不像钟楼。现在人数照旧，工事的钱从**兵的质量**里出：
   * 同样是 5 个人，可能由几个当代尖子变成一群便宜兵，但"十打七"还在。
   */
  const troopHead = headcount;

  const waves: Array<{ atRound: number; types: string[] }> = [];
  /*
   * 试炼的敌人是**写死的少量当代兵**，不按预算生成。
   *
   * 按预算走的话，第一层的人数/钱会把 e3 兵稀释成一堆便宜货，试炼就变成
   * 又一场遭遇战——它要的是"对面两个人，但每个人你都打不动"的压迫感。
   */
  let enemyTypes =
    isTrial
      ? [...(node.trial?.enemy ?? [])]
      : sanitizeAir(pickEnemyTypes(pool, troopBudget, valueOf, troopHead, isHero), run, theme);
  /** 试炼的「师兄」：敌人里最贵的那个修士（一般是剑修），境界比普通弟子高一级 */
  const trialSenior =
    isTrial && node.trial
      ? node.trial.seniorType && node.trial.enemy.includes(node.trial.seniorType)
        ? node.trial.seniorType
        : [...new Set(node.trial.enemy)]
            .filter((t) => CULTIVATORS.has(t))
            .reduce<string | undefined>(
              (best, t) => (!best || costOf(t) > costOf(best) ? t : best),
              undefined,
            )
      : undefined;
  let holdRounds = 0;
  let roundLimit: number;
  /*
   * 守城战：**三席**。
   *
   * A = 玩家（支援，无城）、B = 友军（有城、自带守军与工事）、C = 攻方。
   * 城在 B 手里，玩家只负责补位——这是"帮别人守"该有的样子：城不是你的，
   * 兵也不是你的。攻方因此要更强（守方多了一席），波次从 3 波加到 4 波。
   */
  const allyArmy: ArmyEntry[] = [];
  const allyDefense: ArmyEntry[] = [];
  if (isSpecial) {
    /*
     * 友军的编制：`3 + 层数`。
     *
     * 上一版是 `2 + 层数`（L2 只有 4 个人），实测第 4 轮就被攻方清空，
     * 城只能靠塔和墙硬撑——玩家看到的"友军在家附近看着"其实一半是
     * "友军已经死光了"。多给一个人，它才撑得到你打完。
     */
    const allyCount = 4 + run.layer;
    const allyBudget = enemyScale(run.layer, 'special', allyCount, pool, clockForScale, power).budget * 0.7;
    allyArmy.push(...toArmy(sanitizeAir(pickEnemyTypes(pool, allyBudget, valueOf, allyCount, isHero), run, theme)));
    allyDefense.push({ type: def.tower, count: 1 }, ...(def.wall ? [{ type: def.wall, count: 1 }] : []));

    /*
     * 攻方：人数 = 你 + 盟友 + 层数，分 4 波（开场 / 第 2 / 第 4 / 第 6 轮），
     * 每波预算再 ×1.15——两家人守一座城，攻方不加强就只是来送死。
     */
    const push = Math.max(6, myCount + allyCount + run.layer + 1);
    const shares = [0.4, 0.2, 0.2, 0.2];
    const waveTypes = shares.map((share) => {
      const n = Math.max(2, Math.ceil(push * share));
      const sc = enemyScale(run.layer, 'special', n, pool, clockForScale, power);
      return sanitizeAir(pickEnemyTypes(pool, sc.budget * 1.15, valueOf, n, isHero), run, theme);
    });
    enemyTypes = waveTypes[0] as string[];
    if (waveTypes[1]?.length) waves.push({ atRound: 2, types: waveTypes[1] });
    if (waveTypes[2]?.length) waves.push({ atRound: 4, types: waveTypes[2] });
    if (waveTypes[3]?.length) waves.push({ atRound: 6, types: waveTypes[3] });
    holdRounds = 6 + run.layer;
    roundLimit = holdRounds + 3;
  } else {
    roundLimit = isTrial
      ? 18
      : (isBoss ? 44 : node.kind === 'siege' ? 32 : node.kind === 'elite' ? 24 : 16) + crowd * 2;
  }

  const bonus = bonusOf(run);
  // 斥候网 / 买通：从敌人里减兵（至少留 1 个）
  const cut = Math.min(Math.max(0, enemyTypes.length - 1), bonus.enemyCut);
  const kept = cut > 0 ? enemyTypes.slice(0, enemyTypes.length - cut) : enemyTypes;
  const tempUnits: ArmyEntry[] = bonus.tempUnits > 0 ? [{ type: cheapestOf(theme), count: bonus.tempUnits }] : [];
  // 守城战的工事归友军 B；玩家是支援，没有城也就没有自己的工事
  const playerDefense: ArmyEntry[] = [];

  return {
    kind: node.kind,
    layer: run.layer,
    label: node.title,
    sub: node.sub,
    size,
    era,
    cityEra: theme.eraLow,
    playerArmy: run.army.map((a) => ({ ...a })),
    playerGold: run.gold,
    enemyCityCount,
    playerCity: false,
    allyCity: isSpecial,
    allyArmy,
    allyDefense,
    enemyDefense,
    playerDefense,
    holdRounds,
    waves,
    enemyDamage: bonus.enemyHp,
    defenseDamage: bonus.defenseDamage,
    /*
     * 战场上的工事不是"城里那座满配的塔"：它是临时推上来的、没人修的。
     * 所以统一按 0.65 攻 / 0.85 血折算，再叠世界的口味系数。
     * 不折的话，第三层一座碉堡 36 攻，两座就是每轮 72——比两个顶级兵还狠，
     * 而它还不用走位、不会被先手打掉。
     */
    defenseScale: {
      atk: (def.scale?.atk ?? 1) * 0.65,
      hp: (def.scale?.hp ?? 1) * 0.85,
    },
    enemyTypes: kept,
    enemyGold: enemyCityCount > 0 ? scale.gold : 0,
    // 有城 / 有阵地的敌人守，没城的抢攻；守城战的敌人是来攻城的
    // 守城战的攻方没有城、也不补员；守军（B）靠开局编制，不刷兵
    enemyRecruit: isSpecial ? 0 : isBoss ? 2 : enemyCityCount > 0 ? 1 : 0,
    enemyDoctrine: isSpecial || isTrial || node.kind === 'battle' ? 'rush' : 'boom',
    /*
     * 试验型方略会带"这一层本来没有"的兵（英雄来自奇想包、步枪兵是四代）。
     * 部队里出现的包必须一起开，否则部署时查不到兵种、那个人直接消失。
     */
    expansions: [
      ...new Set([
        ...theme.expansions,
        // 试炼的敌人来自目标世界：当场就要把那个包开出来，否则部署时查不到兵种
        ...(isTrial && node.trial ? WORLDS[node.trial.world].theme.expansions : []),
        ...run.army.flatMap((a) => packsForUnit(a.type)),
      ]),
    ],
    world: run.world,
    rank: isTrial ? (node.trial?.rank ?? 0) : (WORLDS[run.world].rankOf?.(clockForScale) ?? 0),
    /*
     * 玩家这一侧的境界：**时代钟给的下限**与**自己修出来的**取高的那个。
     *
     * 修士是唯一"越打越强"的兵种：一场仗打下来涨的修为存进 `run.cultivation`，
     * 境界可以超过同层的钟——这正是修真线该有的样子（别人换代，你修仙）。
     */
    playerRank: Math.max(
      WORLDS[run.world].rankOf?.(clockForScale) ?? 0,
      ...Object.values(run.cultivation).map(rankOfExp),
      0,
    ),
    cultivation: { ...run.cultivation },
    wounds: { ...run.wounds },
    elderType: pickElder(run, kept),
    trialRank: isTrial ? (node.trial?.rank ?? 0) : undefined,
    trialSeniorRank: isTrial ? node.trial?.seniorRank : undefined,
    trialSeniorType: trialSenior,
    bonusAtk: bonus.atk,
    bonusArmor: bonus.armor,
    bonusHp: bonus.hp,
    bonusMove: bonus.move,
    bonusMoveSlow: bonus.moveSlow,
    cityDamage: bonus.cityDamage,
    tempUnits,
    /*
     * 中立单位：约三分之一的普通/精英/攻坚关里站**两个**"不惹事"的东西，
     * 一左一右贴着战场边缘（2026-11-26 从正中挪过去的）。
     *
     * 它不主动攻击、AI 也不打它，但玩家打它会挨反击；玩家也可以在场外
     * 跟它"交涉"（战斗屏右侧多一张卡）。先做成一个可观察的实验。
     * 守城战不放（三席已经够挤）；层末不放（boss 战不该有第三方）。
     */
    neutral:
      !isSpecial && !isBoss && seed % 100 < 34
        ? [{ type: run.layer === 1 ? 'knight' : run.layer === 2 ? 'rifleman' : 'squad', count: 2 }]
        : [],
    relics: [...run.relics],
    strategyId: run.strategyId,
    seed,
    roundLimit,
  };
}

/**
 * 修真世界的敌方编成：从中挑一个当"长老"。
 *
 * 一排同境界的修士不像宗门，像一个班。挑**最贵的那个修士**当长老，
 * `buildBattle` 会给他额外体格与境界，其余修士压到钟以下。
 */
function pickElder(run: RunState, types: string[]): string | undefined {
  if (run.world !== 'cultivation') return undefined;
  const cults = types.filter((t) => CULTIVATORS.has(t));
  if (cults.length < 2) return undefined;
  return cults.reduce((best, t) => (costOf(t) > costOf(best) ? t : best), cults[0] as string);
}

export function bossFor(run: RunState, seed: number): { node: RoomNode; init: BattleInit } {
  const theme = themeOf(run);
  const rng = makeRng((seed ^ 0x51ed270b) >>> 0);
  const pick = rng.pick(theme.bosses);
  const node: RoomNode = { kind: 'boss', title: pick.title, sub: pick.sub };
  return { node, init: battleFor(run, node, seed) };
}

// ---------------------------------------------------------------- 战斗结算

/** 战斗结束：写回幸存者与金币，返回"这一战拿到了什么" */
export function finishBattle(run: RunState, result: BattleResult): string[] {
  const notes: string[] = [];
  const before = armyCount(run.army);
  const after = armyCount(result.survivors);

  run.army = result.survivors.map((a) => ({ ...a }));
  run.gold = Math.max(0, result.gold);

  /*
   * 伤：活下来的人带着伤进下一场，每战只回 `HEAL_PER_BATTLE`。
   * 阵亡的人已经不在 `survivors` 里了，他们那一条自然消失。
   */
  const wounds: Record<string, number> = {};
  for (const [type, ratio] of Object.entries(result.wounds ?? {})) {
    wounds[type] = Math.min(1, ratio + HEAL_PER_BATTLE);
  }
  run.wounds = wounds;

  /*
   * 修为：**只涨不落**。同类修士取最高的那个——老兵不死，只是凋零，
   * 他修出来的境界留在队伍里。
   */
  for (const [type, exp] of Object.entries(result.cultivation ?? {})) {
    run.cultivation[type] = Math.max(run.cultivation[type] ?? 0, exp);
  }

  /*
   * 这里**不再自动收编**。
   *
   * 上一版每胜一场白送一个兵，是给"奖励只给一个、补不上损耗"打的补丁。
   * 现在战利品本身就是"兵 or 钱"，再来一份白送的，那个选择就没有意义了——
   * 兵力只减不增是这一层的压力来源，补员要靠战利品和商店，不能靠后台。
   */

  /*
   * 随军医官：返还阵亡单位，但**每层只有 2 个额度**。
   *
   * 上一版是"每战返 1 人"：一局二十多场等于白送二十多个人，把"兵力只减不增"
   * 这条压力整个抹平。现在额度按层重置，它仍然是好东西，但不是无限补员。
   */
  const revive = run.relics.reduce((n, id) => n + (relicById(id)?.effect.revive ?? 0), 0);
  if (revive > 0 && after < before && run.reviveLeft > 0) {
    const type = cheapestOf(themeOf(run));
    const n = Math.min(revive, before - after, run.reviveLeft);
    if (n > 0) {
      addUnits(run.army, type, n);
      run.reviveLeft -= n;
      notes.push(`随军医官：${unitName(type)} ×${n} 归队（本层还剩 ${run.reviveLeft} 次）`);
    }
  }

  // 一次性加成只作用于刚打完的这一场
  run.buffs = emptyBuffs();
  notes.push(`幸存 ${armyCount(run.army)} 人`);
  for (const n of notes) run.log.push(n);
  return notes;
}

/**
 * 按时代钟抽一个"本层兵"当奖励。
 *
 * 钟越靠后越可能给高代兵（p = 钟/10），但两边不能一边倒：
 * **给低代时挑该池里最贵的，给高代时挑该池里最便宜的**。
 * 这样钟走到一半的时候，抽到 e1 的斥候和抽到 e2 的长枪兵，实际战力是接近的，
 * 玩家不会觉得"抽到低代就亏了"。
 */
export function rollLayerUnit(theme: LayerTheme, clock: number, rng: Rng): string {
  const p = Math.max(0, Math.min(1, clock / STEPS_PER_LAYER));
  if (rng.next() < p) return byPrice(theme.poolHigh)[0] as string;
  const low = byPrice(theme.pool);
  return low[low.length - 1] as string;
}

/**
 * 战斗奖励（三选一）。
 *
 * 口径（用户定的）：
 *   · 普通 / 攻坚：**略高于一个兵的钱** 或 **一个本层兵**（按时代钟抽代）
 *   · 精英：**略高于三个兵的钱** 或 **三个兵** 或 **一个兵 + 一件藏品**
 *
 * 兵种按 `rollLayerUnit` 抽，所以同一层里前期拿到的是"低代里最好的那个"，
 * 后期才是高代兵——换代是玩家一层一层打出来的，不是进门白送的。
 *
 * 特殊战斗（还没做）预留的是"介于普通和精英之间"，这里不实现。
 */
export function rewardOptions(run: RunState, kind: RoomKind, rng: Rng): RewardOption[] {
  const theme = themeOf(run);
  const owned = new Set(run.relics);
  const unit = rollLayerUnit(theme, run.clock, rng);
  const unitCost = costOf(unit);

  if (kind === 'elite') {
    const relic = RELICS.filter((r) => !owned.has(r.id))[0];
    const gold = Math.round(unitCost * 3 * 1.1);
    const out: RewardOption[] = [
      { id: 'units', title: `${unitName(unit)} ×3`, sub: '三个兵，编进队伍跨层带走', effect: { add: { type: unit, count: 3 } } },
      { id: 'gold', title: `${gold} 金`, sub: '略高于三个兵的价格', effect: { gold } },
    ];
    out.push(
      relic
        ? {
            id: `unit-relic-${relic.id}`,
            title: `${unitName(unit)} ×1 ＋「${relic.name}」`,
            sub: relicDesc(relic.id, run.layer),
            effect: { add: { type: unit, count: 1 }, relic: relic.id },
          }
        : { id: 'drill', title: '整训', sub: '下一战我军攻击 +2', effect: { nextAtk: 2 } },
    );
    return out;
  }

  // 普通战斗与攻坚：攻坚多给一份（它多一座城要啃）
  const mult = kind === 'siege' ? 2 : 1;
  return [
    {
      id: 'unit',
      title: `${unitName(unit)} ×${mult}`,
      sub: mult > 1 ? '两个本层兵，编进队伍跨层带走' : '编进队伍，跨层带走',
      effect: { add: { type: unit, count: mult } },
    },
    {
      id: 'gold',
      title: `${Math.round(unitCost * 1.15 * mult)} 金`,
      sub: '略高于' + (mult > 1 ? '两个' : '一个') + '兵的价格',
      effect: { gold: Math.round(unitCost * 1.15 * mult) },
    },
    { id: 'drill', title: '整训', sub: '下一战我军攻击 +2', effect: { nextAtk: 2 } },
  ];
}

/**
 * 层末战利品：**不给选择，全给**。
 *
 * 按设计：一件藏品 ＋ 一个本层高级兵 ＋ 相当于本层高级兵的钱 ＋ **一个下一层的初级兵**。
 *
 * 最后那一项是关键：不换装之后，玩家会带着一整队上一代的兵进新层，
 * 第一个房间就撞上当代兵。给一个"下一层的兵"是让他有个落脚点，
 * 而不是替他把整支队伍换掉——换代仍然要靠他自己一层一层攒。
 */
export function bossRewards(run: RunState, rng: Rng): string[] {
  const notes: string[] = [];
  const theme = themeOf(run);
  const owned = new Set(run.relics);

  const relicPool = RELICS.filter((r) => !owned.has(r.id));
  const relic = relicPool.length > 0 ? rng.pick(relicPool) : null;
  if (relic) {
    run.relics.push(relic.id);
    notes.push(`藏品「${relic.name}」`);
  } else {
    run.gold += 60;
    notes.push('藏品已集齐，折成 60 金');
  }

  const high = highOf(theme);
  addUnits(run.army, high, 1);
  notes.push(`${unitName(high)} ×1`);
  run.gold += costOf(high);
  notes.push(`${costOf(high)} 金`);

  if (run.layer < 3) {
    const next = themeFor(run.world, (run.layer + 1) as LayerId);
    const first = cheapestOf(next);
    addUnits(run.army, first, 1);
    notes.push(`${unitName(first)} ×1（下一层的兵）`);
  } else {
    run.gold += 120;
    notes.push('120 金（没有下一层了）');
  }

  for (const n of notes) run.log.push(n);
  return notes;
}

/**
 * 守城战的报酬：**不给你挑，全给**。
 *
 * 口径和层末不同：这是"别人谢你"，所以给的是**他家的兵**（这一层最高档之一）
 * 加一件藏品，再添一笔钱。没有三选一——守城这件事本身不是买卖，
 * 你答应了谁，就拿谁的东西。
 */
export function specialRewards(run: RunState, node: RoomNode, rng: Rng): string[] {
  const notes: string[] = [];
  const theme = themeOf(run);
  const unit = node.special?.unit ?? (byPrice(theme.poolHigh).slice(-1)[0] as string);
  const owner = node.special?.name ?? '城里的人';

  addUnits(run.army, unit, 1);
  notes.push(`${owner}给的${unitName(unit)} ×1`);

  const owned = new Set(run.relics);
  const relic = RELICS.filter((r) => !owned.has(r.id));
  if (relic.length > 0) {
    const got = rng.pick(relic);
    run.relics.push(got.id);
    notes.push(`藏品「${got.name}」`);
  } else {
    run.gold += 60;
    notes.push('藏品已集齐，折成 60 金');
  }

  const gold = scaleGold(60, run);
  run.gold += gold;
  notes.push(`${gold} 金`);

  for (const n of notes) run.log.push(n);
  return notes;
}

/** 商店的一件货 */
export interface ShopItem {
  id: string;
  group: 'unit' | 'relic' | 'supply';
  title: string;
  sub: string;
  price: number;
  effect: Effect;
}

const SHOP_REFRESH_COST = 40;

/** 刷新价也跟着层走：第三层花 40 金刷新等于免费 */
export function refreshCost(run: RunState): number {
  return scaleGold(SHOP_REFRESH_COST, run);
}

/** 商店价格折扣（行军图） */
function shopDiscount(run: RunState): number {
  let off = 0;
  for (const id of run.relics) off += relicById(id)?.effect.shopOff ?? 0;
  return Math.min(0.5, off);
}

/**
 * 商店货架：**三行**——兵种 / 藏品 / 补给。
 *
 * 一次给 6 件（3 + 2 + 1），买完不关店，可以接着买；不满意可以花钱刷新。
 * 上一版一次只出一件、买完就走，等于把商店做成了三选一，那不是商店。
 */
export function shopStock(run: RunState, rng: Rng): ShopItem[] {
  const theme = themeOf(run);
  const off = shopDiscount(run);
  /*
   * 行商按"自身费用"的 1.15 倍卖兵（英雄连解锁费一起算）。
   *
   * 这个数字和战利品那条「钱 = 1.15 个兵价」是配平的：一场普通战斗拿钱，
   * 刚好能在店里换回一个兵。于是两个选项的**价值相同、节奏不同**——
   * 选兵是立刻到手（可能不是你想要的兵种），选钱是留着到店里挑（但要等下一家店）。
   * 价差再大的话，选钱就成了陷阱选项（实测 1.4 倍时纯选钱只能通关 2/18）。
   */
  const price = (base: number): number =>
    Math.max(10, Math.round(base * 1.15 * (1 - off) * (1 + (run.layer - 1) * 0.08)));

  /*
   * 英雄：队伍里已经有一位，就不再上架第二位（本体的"英雄唯一"）。
   * 没有英雄时它才出现，价格里含解锁费——这是它"贵得有理"的部分。
   */
  const heroOk = !armyHasHero(run.army);
  const units = rng
    .shuffle([...theme.pool, ...theme.poolHigh])
    .filter((id) => heroOk || !isHero(id))
    .slice(0, 3);
  const owned = new Set(run.relics);
  const relicPool = rng.shuffle(RELICS.filter((r) => !owned.has(r.id)));
  const relics = relicPool.slice(0, 2);

  const stock: ShopItem[] = units.map((id) => ({
    id: `buy-${id}`,
    group: 'unit',
    title: unitName(id),
    sub: isHero(id) ? `英雄 · 造价 ${costOf(id)} ＋ 解锁 ${heroUnlockOf(id)}` : `${costOf(id)} 造价的兵`,
    price: price(valueOf(id)),
    effect: { add: { type: id, count: 1 } },
  }));
  for (const r of relics) {
    stock.push({
      id: `buy-relic-${r.id}`,
      group: 'relic',
      title: `藏品「${r.name}」`,
      sub: relicDesc(r.id, run.layer),
      // 藏品的层价最多 ×6：它的效果跟着层涨，但再乘 ×9 就变成"一件藏品 = 八场战斗的收入"
      price: price((r.price ?? 200) * Math.min(6, priceScale(run))),
      effect: { relic: r.id },
    });
  }
  stock.push({
    id: 'buy-supply',
    group: 'supply',
    title: '随军补给',
    sub: '下一战我军最大生命 +6、护甲 +1',
    // 补给是**定量**的（+6 血 / +1 甲），不随层涨价；涨价就等于第三层花三倍钱
    // 买同样的东西。它在这一层偏弱是应该的——那是"钱多到没处花"的出口。
    price: price(110),
    effect: { nextHp: 6, nextArmor: 1 },
  });
  return stock;
}

/**
 * 休整房：从池里抽 3 个选项。
 *
 * 价钱**按兵价算**，不用写死的 90/80/60：第三层的"高级兵"是 400 造价的
 * 主战坦克，还用 80 金卖它就是白送。募饷的金额则按层的水位换算。
 */
export function restOptions(run: RunState, rng: Rng): RewardOption[] {
  const theme = themeOf(run);
  const low = cheapestOf(theme);
  const high = highOf(theme);
  const round10 = (n: number): number => Math.round(n / 10) * 10;
  const wage = scaleGold(90, run);
  const recruitCost = round10(valueOf(high) * 0.9);
  const musterCost = round10(valueOf(low) * 1.2);
  const hintOf: Record<string, string> = {
    reinforce: `得 1 个本层基础兵（${unitName(low)}）`,
    wage: `+${wage} 金`,
    recruit: `−${recruitCost} 金，得 1 个本层高级兵（${unitName(high)}）`,
    reform: '把 1 个最低级的兵换成 1 个本层高级兵',
    muster: `−${musterCost} 金，得 2 个本层基础兵`,
  };
  const opts = rng.shuffle([...REST_OPTIONS]).slice(0, 3);
  const built: RewardOption[] = opts.map((o) => ({
    id: o.id,
    title: o.label,
    sub: hintOf[o.id] ?? o.hint,
    effect:
      o.id === 'reinforce'
        ? { add: { type: low, count: 1 } }
        : o.id === 'wage'
          ? { gold: wage }
          : o.id === 'recruit'
            ? { gold: -recruitCost, add: { type: high, count: 1 } }
            : o.id === 'reform'
              ? { promote: 1 }
              : { gold: -musterCost, add: { type: low, count: 2 } },
  }));
  // 掏不起的选项不上桌（和事件同一个口径）；全掏不起就照旧全给
  const afford = built.filter((o) => (o.effect.gold ?? 0) >= 0 || run.gold >= Math.abs(o.effect.gold ?? 0));
  return afford.length > 0 ? afford : built;
}

/** 临战决议：抽 3 个给玩家选 1 个。花钱的那两条按层换算（第三层的 120 金太便宜） */
export function decisionOptions(run: RunState, rng: Rng): DecisionOption[] {
  const k = priceScale(run);
  return rng.shuffle([...DECISIONS]).slice(0, 3).map((o) => {
    if (!o.cost) return { ...o };
    const cost = Math.round((o.cost * k) / 10) * 10;
    return { ...o, cost, hint: o.hint.replace(/−\d+ 金/, `−${cost} 金`) };
  });
}

/** 把决议的加成写进 run（在开 boss 之前调用） */
export function applyDecision(run: RunState, opt: DecisionOption): void {
  if (opt.cost) run.gold = Math.max(0, run.gold - opt.cost);
  run.buffs.atk += opt.atk ?? 0;
  run.buffs.hp += opt.hp ?? 0;
  run.buffs.armor += opt.armor ?? 0;
  run.buffs.enemyCut += opt.enemyCut ?? 0;
  run.buffs.cityDamage += opt.cityDamage ?? 0;
  run.buffs.defenseDamage += opt.defenseDamage ?? 0;
  run.buffs.enemyHp += opt.enemyHp ?? 0;
  run.buffs.move += opt.move ?? 0;
  run.buffs.tempUnits += opt.tempUnits ?? 0;
  run.log.push(`临战决议：${opt.label}`);
}

// ---------------------------------------------------------------- 层推进

/**
 * 这个试炼还算不算数：已经定了路、或这支史被明确排斥，就不再给锁定奖励。
 *
 * 房间在开局就生成在图上，不能因为后来路定了就凭空消失——进房时按普通战斗
 * 处理（门上的字也会变），玩家不会撞见一个"点了没反应"的房间。
 */
export function trialActive(run: RunState, node: RoomNode): boolean {
  if (node.kind !== 'trial' || !node.trial) return false;
  if (run.worldLock) return false;
  if (run.worldBan.includes(node.trial.world)) return false;
  return true;
}

/**
 * 第一层走完：把这一局的路定下来。
 *
 * 取代原来的「第一层末四选一」。路是事件/试炼攒出来的：
 *   · 锁定了某支 → 进那一支（试炼赢的那支、或事件里站队的那支）；
 *   · 什么都没做（或只 ban 过）→ **正史**。
 * 二三层不再有分支，这个函数只该在第一层末调用一次。
 */
export function resolveWorld(run: RunState): WorldId {
  const world = run.worldLock ?? 'base';
  run.world = world;
  run.log.push(`这一层的路：${WORLDS[world].name}`);
  return world;
}

/** 走到下一层：发军饷袋/军粮袋、重排房间图。返回 false 表示这一局已经打完了 */
export function nextLayer(run: RunState, seed: number): boolean {
  if (run.layer >= 3) {
    run.over = {
      win: true,
      title: '常规结局 · 破钟',
      body: '钟楼倒了，钟声断在半途。这一代到此为止——你没有再往前走。',
    };
    return false;
  }
  const layer = (run.layer + 1) as LayerId;
  run.layer = layer;
  run.step = 0;
  run.clock = 0;
  run.bossDone = false;
  run.reviveLeft = run.relics.includes('medic') ? 2 : 0;
  // 换层整补：伤在这一层里带着，进下一层就回满了（修为不重置）
  run.wounds = {};
  run.buffs = emptyBuffs();
  const rng = makeRng((seed ^ (layer * 0x2545f491)) >>> 0);
  run.plan = planLayer(layer, rng, themeFor(run.world, layer));

  /*
   * 这里**不换装**。
   *
   * 上一版是"进新层自动把旧兵升级成当代同职能兵"，那是替玩家做决定：
   * 队伍的换代节奏应该由他自己掌握（拿奖励、逛商店、打层末），
   * 而不是进门就被换掉。旧兵留在队里当老兵，怎么处理由玩家选。
   */
  const notes: string[] = [];
  /*
   * 成长型单位（试验队 / 英雄）：**进层就是"又长了一次"**，在这里说一声。
   *
   * 成长不是状态，而是 `layer` 的函数（见 `data.ts` 的 `growthOf`），
   * 所以不需要在存档里记等级；只需要在换层时报一句，让玩家知道
   * "刚才那个半成品现在长成什么样了"。
   */
  for (const type of new Set(run.army.map((a) => a.type))) {
    const now = growthOf(type, layer);
    const was = growthOf(type, layer - 1);
    if (!now || now.step === was?.step) continue;
    notes.push(
      now.step >= now.fullAt
        ? `${unitName(type)} 长成了完全体`
        : `${unitName(type)} 又长了一截（${now.step}/${now.fullAt}）`,
    );
  }
  for (const id of run.relics) {
    const e = relicById(id)?.effect;
    if (!e) continue;
    if (e.goldPerLayer) {
      const g = scaleGold(e.goldPerLayer, run);
      run.gold += g;
      notes.push(`军饷袋：+${g} 金`);
    }
    if (e.unitPerLayer) {
      const type = cheapestOf(themeOf(run));
      addUnits(run.army, type, e.unitPerLayer);
      notes.push(`军粮袋：${unitName(type)} ×${e.unitPerLayer}`);
    }
  }
  run.log.push(`进入${themeOf(run).name}`);
  for (const n of notes) run.log.push(n);
  return true;
}

/** 失败结算 */
export function loseRun(run: RunState, why: string): void {
  run.over = {
    win: false,
    title: '这一代到此为止',
    body: `${why}。番号还在，人没了。下一局换个人接着打。`,
  };
}

export {
  DECISIONS,
  EVENTS,
  RELICS,
  REST_OPTIONS,
  STRATEGIES,
  packsForUnit,
  eventById,
  relicById,
  strategyById,
  unitName,
  cheapestOf,
  midOf,
  highOf,
};
