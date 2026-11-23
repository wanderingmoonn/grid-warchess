/**
 * 一局肉鸽的纯逻辑：房间图生成、效果结算、跨层推进。
 *
 * 这里**不碰 DOM，也不碰规则层**——除了查一下兵种造价。
 * 好处是整套流程可以在 node 里直接跑（见 scripts/rogue-smoke.ts），
 * 不用开浏览器就能验证"十步走完 → boss → 下一层"这条链没有断。
 */
import { UNIT_TYPES } from '../core/config.ts';
import {
  EVENTS,
  LAYERS,
  RELICS,
  REST_OPTIONS,
  PLACE_NAMES,
  STRATEGIES,
  eventById,
  pickEnemyTypes,
  relicById,
  strategyById,
  unitName,
} from './data.ts';
import type { LayerTheme } from './data.ts';
import { makeRng } from './rng.ts';
import type { Rng } from './rng.ts';
import type {
  ArmyEntry,
  BattleInit,
  BattleResult,
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

/** 本层最便宜的兵（补员用） */
function cheapestOf(theme: LayerTheme): string {
  let best = theme.pool[0] as string;
  for (const id of theme.pool) if (costOf(id) < costOf(best)) best = id;
  return best;
}

/** 本层池子里"中间档"和"最高档"的兵，事件里用来区分奖励高低 */
function midOf(theme: LayerTheme): string {
  const sorted = [...theme.pool].sort((a, b) => costOf(a) - costOf(b));
  return sorted[Math.floor(sorted.length / 2)] as string;
}

function highOf(theme: LayerTheme): string {
  const sorted = [...theme.pool].sort((a, b) => costOf(a) - costOf(b));
  return sorted[sorted.length - 1] as string;
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
 * 锚点只钉"这一步有这门"，不钉"哪一扇"，同一步的两扇门顺序也会洗。
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

  // 锚点已经用掉的数量要从袋子里扣掉
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
      doors.push(makeRoom(kind, layer, rng, () => {
        const def = eventPool[eventCursor % eventPool.length] as EventDef;
        eventCursor += 1;
        return def.id;
      }));
    }
    steps.push(doors);
  }
  return { steps };
}

function makeRoom(
  kind: RoomKind,
  layer: LayerId,
  rng: Rng,
  nextEvent: () => string,
): RoomNode {
  const places = PLACE_NAMES[layer];
  const place = rng.pick(places);
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
  const run: RunState = {
    seed,
    strategyId,
    layer: 1,
    step: 0,
    gold: 180,
    army,
    relics: [],
    plan: planLayer(1, rng),
    clock: 0,
    nextAtk: 0,
    bossDone: false,
    log: [`开局：${strategy.name}，${armyText(army)}`],
    over: null,
  };
  return run;
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
    run.nextAtk += effect.nextAtk;
    notes.push(`下一战攻击 ${effect.nextAtk > 0 ? '+' : ''}${effect.nextAtk}`);
  }
  if (effect.add) {
    const type =
      effect.add.type === 'layer-mid'
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
  if (effect.promote) {
    notes.push('整训完成');
  }
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
 *
 * 以前是按层写死预算，结果 L1 的敌人比玩家初始编成强、L3 又偏弱；
 * 现在玩家打到 L3 时部队早就换过血，预算跟着部队走才不会忽强忽弱。
 * 时代钟再叠一点：逛得越久，对面越硬。
 */
function enemyScale(kind: RoomKind, myCost: number, clock: number): { budget: number; gold: number } {
  const clockK = 1 + clock * 0.04;
  const k: Record<string, number> = { battle: 0.6, elite: 0.75, siege: 0.85, boss: 0.95 };
  const budget = Math.max(45, Math.round(myCost * (k[kind] ?? 0.8) * clockK));
  return { budget, gold: Math.round(budget * 0.35) };
}

export function battleFor(run: RunState, node: RoomNode, seed: number): BattleInit {
  const theme = themeOf(run.layer);
  const isBoss = node.kind === 'boss';
  const idx = isBoss ? 3 : node.kind === 'siege' ? 2 : node.kind === 'elite' ? 1 : 0;
  const size = theme.size[idx] as number;
  // 遭遇/精英：双方无城；攻坚 1 座；层末第 1、2 层 1 座，钟楼（第 3 层）2 座
  const enemyCityCount: 0 | 1 | 2 = node.kind === 'siege' ? 1 : isBoss && run.layer >= 3 ? 2 : 0;
  const bossCities: 0 | 1 | 2 = isBoss ? (run.layer >= 3 ? 2 : 1) : enemyCityCount;
  const era = isBoss ? theme.eraHigh : run.clock >= 6 ? theme.eraHigh : theme.eraLow;
  const scale = enemyScale(node.kind, armyCost(run.army), isBoss ? STEPS_PER_LAYER : run.clock);
  const types = pickEnemyTypes(theme.pool, scale.budget, costOf);
  /*
   * 回合上限按小图重算：8×8 的遭遇战打 30 轮是不可能的，那是"两边都不想打"。
   * 小图 + 短兵相接，10~16 轮就该分出结果；攻坚要啃两座城，多给一些。
   */
  const roundLimit = isBoss ? 30 : node.kind === 'siege' ? 26 : node.kind === 'elite' ? 18 : 16;

  return {
    kind: node.kind,
    layer: run.layer,
    label: node.title,
    sub: node.sub,
    size,
    era,
    playerArmy: run.army.map((a) => ({ ...a })),
    playerGold: run.gold,
    enemyCityCount: bossCities,
    enemyTypes: types,
    // 无城关卡没有产线，给钱也没用；有城的关卡给一笔，让它能补员
    enemyGold: enemyCityCount > 0 ? scale.gold : 0,
    relics: [...run.relics],
    strategyId: run.strategyId,
    nextAtk: run.nextAtk,
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
   * 折掉两三个人，打到第 4 个房就没人了。这不是难度，是算术——战利品一次只给一个，
   * 补不上损耗。收编把"打赢就有兵"变成稳定收入，长局才跑得下去。
   */
  if (after > 0) {
    const type = cheapestOf(themeOf(run.layer));
    addUnits(run.army, type, 1);
    notes.push(`收编：${unitName(type)} ×1`);
  }

  // 随军医官：一场战斗后返还 1 个阵亡单位（用最低级的兵补）
  if (run.relics.includes('medic') && after < before) {
    const type = cheapestOf(themeOf(run.layer));
    addUnits(run.army, type, 1);
    notes.push(`随军医官：${unitName(type)} ×1 归队`);
  }

  run.nextAtk = 0;
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
    {
      id: 'unit',
      title: `${unitName(unit)} ×1`,
      sub: '编进队伍，跨层保留',
      effect: { add: { type: unit, count: 1 } },
    },
    {
      id: 'gold',
      title: `${gold} 金`,
      sub: '军饷，能带进下一层',
      effect: { gold },
    },
  ];
  if (relic) {
    out.push({ id: `relic-${relic.id}`, title: `藏品「${relic.name}」`, sub: relic.desc, effect: { relic: relic.id } });
  } else {
    out.push({ id: 'drill', title: '整训', sub: '下一战我军攻击 +2', effect: { nextAtk: 2 } });
  }
  // 抽掉一条，避免每局都是"永远选第一项"
  return rng.shuffle(out).slice(0, 3);
}

/** 商店货架：两个本层兵 + 一件藏品，价格随层数上浮 */
export function shopStock(run: RunState, rng: Rng): RewardOption[] {
  const theme = themeOf(run.layer);
  const pool = rng.shuffle([...theme.pool]).slice(0, 2);
  const owned = new Set(run.relics);
  const relic = rng.pick(RELICS.filter((r) => !owned.has(r.id)).length > 0
    ? RELICS.filter((r) => !owned.has(r.id))
    : RELICS);
  const markup = 1 + (run.layer - 1) * 0.1;

  const stock: RewardOption[] = pool.map((id) => ({
    id: `buy-${id}`,
    title: unitName(id),
    sub: `${Math.round(costOf(id) * markup)} 金`,
    effect: { add: { type: id, count: 1 }, gold: -Math.round(costOf(id) * markup) },
  }));
  stock.push({
    id: `buy-relic-${relic.id}`,
    title: `藏品「${relic.name}」`,
    sub: `${Math.round(170 * markup)} 金 · ${relic.desc}`,
    effect: { relic: relic.id, gold: -Math.round(170 * markup) },
  });
  return stock;
}

/** 休整房：从池里抽 3 个选项（池只有 3 个，等于固定，正式版会扩） */
export function restOptions(run: RunState, rng: Rng): RewardOption[] {
  const theme = themeOf(run.layer);
  const opts = rng.shuffle([...REST_OPTIONS]);
  return opts.map((o) => ({
    id: o.id,
    title: o.label,
    sub: o.hint,
    effect:
      o.effect === 'reinforce'
        ? { add: { type: cheapestOf(theme), count: 1 } }
        : o.effect === 'wage'
          ? { gold: 90 }
          : { nextAtk: 2 },
  }));
}

// ---------------------------------------------------------------- 层推进

/** 走到下一层：发军饷袋、重排房间图。返回 false 表示这一局已经打完了 */
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
  const rng = makeRng((seed ^ (layer * 0x2545f491)) >>> 0);
  run.plan = planLayer(layer, rng);
  if (run.relics.includes('purse')) {
    run.gold += 90;
    run.log.push('军饷袋：+90 金');
  }
  run.log.push(`进入${themeOf(layer).name}`);
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

export { EVENTS, RELICS, REST_OPTIONS, STRATEGIES, eventById, strategyById, relicById, unitName, cheapestOf, midOf, highOf };
