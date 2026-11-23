/**
 * 一局肉鸽的纯逻辑：房间图生成、效果结算、跨层推进、敌人编成。
 *
 * 这里**不碰 DOM，也不碰规则层**——除了查一下兵种造价。
 * 好处是整套流程可以在 node 里直接跑（见 scripts/rogue-smoke.ts），
 * 不用开浏览器就能验证"十步走完 → boss → 下一层"这条链没有断。
 */
import { UNIT_TYPES } from '../core/config.ts';
import {
  DECISIONS,
  EVENTS,
  LAYERS,
  PLACE_NAMES,
  RELICS,
  REST_OPTIONS,
  STRATEGIES,
  eventById,
  pickEnemyTypes,
  relicById,
  strategyById,
  unitName,
} from './data.ts';
import type { DecisionOption, LayerTheme } from './data.ts';
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
} from './types.ts';

export const STEPS_PER_LAYER = 10;
export const ROOMS_PER_LAYER = STEPS_PER_LAYER * 2;

const costOf = (id: string): number => UNIT_TYPES[id]?.cost ?? 0;

export function themeOf(layer: LayerId): LayerTheme {
  return LAYERS[layer];
}

export function emptyBuffs(): Buffs {
  return { atk: 0, armor: 0, hp: 0, enemyCut: 0, cityDamage: 0, tempUnits: 0 };
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

export function armyText(army: ArmyEntry[]): string {
  if (army.length === 0) return '（空）';
  return army.map((a) => `${unitName(a.type)}×${a.count}`).join('、');
}

/** 按造价排序后的池子 */
function byPrice(pool: readonly string[]): string[] {
  return [...pool].sort((a, b) => costOf(a) - costOf(b));
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

/**
 * 换装：进新一层时把旧兵换成这一代的同职能兵。
 *
 * 为什么要有：三层跨了 1→3→5 代，上一层的兵到下一层基本是活靶子；
 * 而玩家没有产线，只能靠奖励零散补几个。不换装的话，第二层开局就废一半。
 * 映射表写在 `data.ts` 的 `refit` 里（一眼能看出谁换成了谁）。
 */
export function refitArmy(run: RunState): string[] {
  const map = themeOf(run.layer).refit;
  if (Object.keys(map).length === 0) return [];
  const notes: string[] = [];
  for (const entry of run.army) {
    const to = map[entry.type];
    if (to && to !== entry.type) {
      entry.type = to;
      notes.push(unitName(to));
    }
  }
  // 换完会撞车（戈兵和长枪兵都换成戟兵）：同兵种要合并，否则列表里出现两行戟兵
  const merged = new Map<string, number>();
  for (const e of run.army) merged.set(e.type, (merged.get(e.type) ?? 0) + e.count);
  run.army = [...merged.entries()].map(([type, count]) => ({ type, count }));
  return [...new Set(notes)];
}

// ---------------------------------------------------------------- 房间图

const BAG: RoomKind[] = [
  ...Array<RoomKind>(6).fill('battle'),
  ...Array<RoomKind>(2).fill('elite'),
  ...Array<RoomKind>(2).fill('siege'),
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
export function planLayer(layer: LayerId, rng: Rng): LayerPlan {
  const slots: Array<RoomKind | null> = Array<RoomKind | null>(ROOMS_PER_LAYER).fill(null);
  const at = (step: number, door: number): number => step * 2 + door;

  slots[at(0, 0)] = 'battle';
  slots[at(0, 1)] = 'battle';
  slots[at(2, rng.int(2))] = 'shop';
  slots[at(6, rng.int(2))] = 'shop';
  slots[at(3, rng.int(2))] = 'rest';
  slots[at(7, rng.int(2))] = 'rest';

  const bag: RoomKind[] = [];
  const need: Record<string, number> = {};
  for (const k of BAG) need[k] = (need[k] ?? 0) + 1;
  for (const k of slots) if (k) need[k] = (need[k] ?? 0) - 1;
  for (const [k, n] of Object.entries(need)) for (let i = 0; i < n; i += 1) bag.push(k as RoomKind);
  rng.shuffle(bag);

  for (let i = 0; i < slots.length; i += 1) if (!slots[i]) slots[i] = bag.pop() ?? 'battle';

  const eventPool = rng.shuffle([...EVENTS]);
  let eventCursor = 0;

  const steps: RoomNode[][] = [];
  for (let step = 0; step < STEPS_PER_LAYER; step += 1) {
    const doors: RoomNode[] = [];
    for (let door = 0; door < 2; door += 1) {
      const kind = slots[at(step, door)] as RoomKind;
      doors.push(
        makeRoom(kind, layer, rng, () => {
          const def = eventPool[eventCursor % eventPool.length] as EventDef;
          eventCursor += 1;
          return def.id;
        }),
      );
    }
    steps.push(doors);
  }
  return { steps };
}

function makeRoom(kind: RoomKind, layer: LayerId, rng: Rng, nextEvent: () => string): RoomNode {
  const place = rng.pick(PLACE_NAMES[layer]);
  switch (kind) {
    case 'battle':
      return { kind, title: '遭遇战', sub: `${place} · 无人据守的野地` };
    case 'elite':
      return { kind, title: '精英战', sub: `${place} · 对方压上了本钱` };
    case 'siege':
      return { kind, title: '攻坚战', sub: `${place} · 城在对面手里` };
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
  return {
    seed,
    strategyId,
    layer: 1,
    step: 0,
    gold: 180,
    army,
    relics: [],
    plan: planLayer(1, rng),
    clock: 0,
    buffs: emptyBuffs(),
    bossDone: false,
    log: [`开局：${strategy.name}，${armyText(army)}`],
    over: null,
  };
}

// ---------------------------------------------------------------- 效果

/** 应用一条效果。`random` 类的藏品在这里落地，所以需要 rng */
export function applyEffect(run: RunState, effect: Effect, rng: Rng): string[] {
  const notes: string[] = [];
  const theme = themeOf(run.layer);

  if (typeof effect.gold === 'number' && effect.gold !== 0) {
    run.gold = Math.max(0, run.gold + effect.gold);
    notes.push(`${effect.gold > 0 ? '+' : ''}${effect.gold} 金`);
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
    const type =
      effect.add.type === 'layer-low'
        ? cheapestOf(theme)
        : effect.add.type === 'layer-mid'
          ? midOf(theme)
          : effect.add.type === 'layer-high'
            ? highOf(theme)
            : effect.add.type;
    addUnits(run.army, type, effect.add.count);
    notes.push(`${unitName(type)} ×${effect.add.count}`);
  }
  if (effect.relic) {
    const owned = new Set(run.relics);
    const id =
      effect.relic === 'random'
        ? (RELICS.filter((r) => !owned.has(r.id))[0]?.id ?? rng.pick(RELICS).id)
        : effect.relic;
    if (!owned.has(id) && relicById(id)) {
      run.relics.push(id);
      notes.push(`藏品「${relicById(id)?.name ?? id}」`);
    } else {
      run.gold += 60;
      notes.push('重复的藏品折成 +60 金');
    }
  }
  if (effect.promote) notes.push('整训完成');
  for (const n of notes) run.log.push(n);
  return notes;
}

/** 房间走完：步数与时代钟一起涨 */
export function afterRoom(run: RunState): void {
  run.step = Math.min(STEPS_PER_LAYER, run.step + 1);
  run.clock = Math.min(STEPS_PER_LAYER, run.clock + 1);
}

// ---------------------------------------------------------------- 战斗输入

/**
 * 敌方编成：**按我方全军造价乘一个 k**（文档里的那条"敌人永远是你的镜像"）。
 * 时代钟再叠一点：逛得越久，对面越硬。
 */
function enemyScale(kind: RoomKind, myCost: number, clock: number): { budget: number; gold: number } {
  const clockK = 1 + clock * 0.04;
  const k: Record<string, number> = { battle: 0.6, elite: 0.72, siege: 0.7, boss: 0.85 };
  const budget = Math.max(45, Math.round(myCost * (k[kind] ?? 0.6) * clockK));
  return { budget, gold: Math.round(budget * 0.25) };
}

/** 藏品 + 方略 + 攒下的一次性加成，合成这一场的我军加成 */
export function bonusOf(run: RunState): {
  atk: number;
  armor: number;
  hp: number;
  move: number;
  enemyCut: number;
  cityDamage: number;
  tempUnits: number;
} {
  let atk = 0;
  let armor = 0;
  let hp = 0;
  let move = 0;
  let enemyCut = 0;
  let cityDamage = 0;
  for (const id of run.relics) {
    const e = relicById(id)?.effect;
    if (!e) continue;
    atk += e.atk ?? 0;
    armor += e.armor ?? 0;
    hp += e.hp ?? 0;
    move += e.move ?? 0;
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
  return { atk, armor, hp, move, enemyCut, cityDamage, tempUnits: run.buffs.tempUnits };
}

export function battleFor(run: RunState, node: RoomNode, seed: number): BattleInit {
  const theme = themeOf(run.layer);
  const isBoss = node.kind === 'boss';
  const idx = isBoss ? 3 : node.kind === 'siege' ? 2 : node.kind === 'elite' ? 1 : 0;
  const size = theme.size[idx] as number;
  // 时代钟靠后（≥6）或层末 → 用高代兵池
  const high = isBoss || run.clock >= 6;
  const era = high ? theme.eraHigh : theme.eraLow;
  const pool = high ? theme.poolHigh : theme.pool;
  // 遭遇/精英：双方无城；攻坚 1 座；层末 L1–L2 一座、L3 两座
  const enemyCityCount: 0 | 1 | 2 = node.kind === 'siege' ? 1 : isBoss ? (run.layer >= 3 ? 2 : 1) : 0;
  const scale = enemyScale(node.kind, armyCost(run.army), isBoss ? STEPS_PER_LAYER : run.clock);
  const types = pickEnemyTypes(pool, scale.budget, costOf);
  const bonus = bonusOf(run);
  // 斥候网 / 买通：从敌人里减兵（至少留 1 个）
  const cut = Math.min(Math.max(0, types.length - 1), bonus.enemyCut);
  const kept = cut > 0 ? types.slice(0, types.length - cut) : types;

  /*
   * 回合上限按小图重算：8×8 的遭遇战打 30 轮是不可能的，那是"两边都不想打"。
   * 有城的关卡 AI 会守，多给几轮。
   */
  const roundLimit = isBoss ? 34 : node.kind === 'siege' ? 30 : node.kind === 'elite' ? 18 : 16;
  const tempUnits: ArmyEntry[] = bonus.tempUnits > 0 ? [{ type: cheapestOf(theme), count: bonus.tempUnits }] : [];

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
    enemyTypes: kept,
    enemyGold: enemyCityCount > 0 ? scale.gold : 0,
    // 有城的关让敌人守（它得守住城），没城的关让它抢攻
    // 整场最多补这么多个（不是每回合）——城因此有防守价值，但撑不了无限磨
    enemyRecruit: enemyCityCount > 0 ? 2 : 0,
    enemyDoctrine: enemyCityCount > 0 ? 'boom' : 'rush',
    expansions: theme.expansions,
    bonusAtk: bonus.atk,
    bonusArmor: bonus.armor,
    bonusHp: bonus.hp,
    bonusMove: bonus.move,
    cityDamage: bonus.cityDamage,
    tempUnits,
    relics: [...run.relics],
    strategyId: run.strategyId,
    seed,
    roundLimit,
  };
}

export function bossFor(run: RunState, seed: number): { node: RoomNode; init: BattleInit } {
  const theme = themeOf(run.layer);
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
   * 收编：每打赢一场，自动补 1 个本层基础兵。
   *
   * 为什么需要：玩家没有城、也不能在战斗里造兵，编制只减不增；实测一场胜仗要
   * 折掉两三个人，打到第 4 个房就没人了。这不是难度，是算术。
   */
  if (after > 0) {
    const type = cheapestOf(themeOf(run.layer));
    addUnits(run.army, type, 1);
    notes.push(`收编：${unitName(type)} ×1`);
  }

  // 随军医官：一场战斗后返还 N 个阵亡单位（用最低级的兵补）
  const revive = run.relics.reduce((n, id) => n + (relicById(id)?.effect.revive ?? 0), 0);
  if (revive > 0 && after < before) {
    const type = cheapestOf(themeOf(run.layer));
    const n = Math.min(revive, before - after);
    addUnits(run.army, type, n);
    notes.push(`随军医官：${unitName(type)} ×${n} 归队`);
  }

  // 一次性加成只作用于刚打完的这一场
  run.buffs = emptyBuffs();
  notes.push(`幸存 ${armyCount(run.army)} 人`);
  for (const n of notes) run.log.push(n);
  return notes;
}

/** 战斗奖励的候选（三选一） */
export function rewardOptions(run: RunState, kind: RoomKind, rng: Rng): RewardOption[] {
  const theme = themeOf(run.layer);
  const owned = new Set(run.relics);
  const relic = RELICS.filter((r) => !owned.has(r.id))[0];
  const gold = kind === 'boss' ? 200 : kind === 'siege' ? 120 : kind === 'elite' ? 90 : 60;
  const unit = kind === 'boss' ? highOf(theme) : midOf(theme);

  const out: RewardOption[] = [
    { id: 'unit', title: `${unitName(unit)} ×1`, sub: '编进队伍，跨层保留', effect: { add: { type: unit, count: 1 } } },
    { id: 'gold', title: `${gold} 金`, sub: '军饷，能带进下一层', effect: { gold } },
  ];
  if (relic) {
    out.push({ id: `relic-${relic.id}`, title: `藏品「${relic.name}」`, sub: relic.desc, effect: { relic: relic.id } });
  } else {
    out.push({ id: 'drill', title: '整训', sub: '下一战我军攻击 +2', effect: { nextAtk: 2 } });
  }
  return rng.shuffle(out).slice(0, 3);
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

export function refreshCost(): number {
  return SHOP_REFRESH_COST;
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
  const theme = themeOf(run.layer);
  const off = shopDiscount(run);
  const price = (base: number): number =>
    Math.max(10, Math.round(base * (1 - off) * (1 + (run.layer - 1) * 0.08)));

  const units = rng.shuffle([...theme.pool, ...theme.poolHigh]).slice(0, 3);
  const owned = new Set(run.relics);
  const relicPool = rng.shuffle(RELICS.filter((r) => !owned.has(r.id)));
  const relics = relicPool.slice(0, 2);

  const stock: ShopItem[] = units.map((id) => ({
    id: `buy-${id}`,
    group: 'unit',
    title: unitName(id),
    sub: `${costOf(id)} 造价的兵`,
    price: price(costOf(id)),
    effect: { add: { type: id, count: 1 } },
  }));
  for (const r of relics) {
    stock.push({
      id: `buy-relic-${r.id}`,
      group: 'relic',
      title: `藏品「${r.name}」`,
      sub: r.desc,
      price: price(170),
      effect: { relic: r.id },
    });
  }
  stock.push({
    id: 'buy-supply',
    group: 'supply',
    title: '随军补给',
    sub: '下一战我军最大生命 +6、护甲 +1',
    price: price(90),
    effect: { nextHp: 6, nextArmor: 1 },
  });
  return stock;
}

/** 休整房：从池里抽 3 个选项 */
export function restOptions(run: RunState, rng: Rng): RewardOption[] {
  const theme = themeOf(run.layer);
  const opts = rng.shuffle([...REST_OPTIONS]).slice(0, 3);
  return opts.map((o) => ({
    id: o.id,
    title: o.label,
    sub: o.hint,
    effect:
      o.id === 'reinforce'
        ? { add: { type: cheapestOf(theme), count: 1 } }
        : o.id === 'wage'
          ? { gold: 90 }
          : o.id === 'drill'
            ? { nextAtk: 2 }
            : o.id === 'harden'
              ? { nextHp: 6 }
              : { gold: -80, add: { type: highOf(theme), count: 1 } },
  }));
}

/** 临战决议：抽 3 个给玩家选 1 个 */
export function decisionOptions(run: RunState, rng: Rng): DecisionOption[] {
  void run;
  return rng.shuffle([...DECISIONS]).slice(0, 3);
}

/** 把决议的加成写进 run（在开 boss 之前调用） */
export function applyDecision(run: RunState, opt: DecisionOption): void {
  if (opt.cost) run.gold = Math.max(0, run.gold - opt.cost);
  run.buffs.atk += opt.atk ?? 0;
  run.buffs.hp += opt.hp ?? 0;
  run.buffs.armor += opt.armor ?? 0;
  run.buffs.enemyCut += opt.enemyCut ?? 0;
  run.buffs.cityDamage += opt.cityDamage ?? 0;
  run.buffs.tempUnits += opt.tempUnits ?? 0;
  run.log.push(`临战决议：${opt.label}`);
}

// ---------------------------------------------------------------- 层推进

/** 走到下一层：发军饷袋/军粮袋、换装、重排房间图。返回 false 表示这一局已经打完了 */
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
  run.buffs = emptyBuffs();
  const rng = makeRng((seed ^ (layer * 0x2545f491)) >>> 0);
  run.plan = planLayer(layer, rng);

  const notes: string[] = [];
  const refit = refitArmy(run);
  if (refit.length > 0) notes.push(`换装：${refit.join('、')}`);
  for (const id of run.relics) {
    const e = relicById(id)?.effect;
    if (!e) continue;
    if (e.goldPerLayer) {
      run.gold += e.goldPerLayer;
      notes.push(`军饷袋：+${e.goldPerLayer} 金`);
    }
    if (e.unitPerLayer) {
      const type = cheapestOf(themeOf(layer));
      addUnits(run.army, type, e.unitPerLayer);
      notes.push(`军粮袋：${unitName(type)} ×${e.unitPerLayer}`);
    }
  }
  run.log.push(`进入${themeOf(layer).name}`);
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
  eventById,
  relicById,
  strategyById,
  unitName,
  cheapestOf,
  midOf,
  highOf,
};
