/**
 * 资源表与结算工具。
 *
 * 原版只流通金币，但规则层从第一天起就该认"资源不止一种"这件事：
 * 养兵吃粮、盖楼用材，这两条比金币更硬。之所以现在才补：
 * 金币在代码里是 `player.gold` 一个数字，散落在两百多处读写里，
 * 直接改成"资源表"会把每一处都变成 `?.` 容错；而先留出接口、
 * 让扩展去用，代价只有这个文件和几行 helper。
 *
 * 三条约定：
 *   1. gold 永远是"主资源"，读写仍然走 `player.gold`（快、直观、旧存档能读）。
 *   2. 其它资源一律走 `player.res[id]`，默认 0，不用初始化。
 *   3. 规则层不认识"粮食""建材"这些名字，只认 id；名字和颜色在这个表里，
 *      所以扩展加一种新资源只需要在这里注册一行。
 */

import type { PlayerId, ResourceId, UnitTypeDef } from './types.ts';

/** 主资源的 id。写死成常量，避免各处手打字符串。 */
export const GOLD: ResourceId = 'gold';

export interface ResourceDef {
  id: ResourceId;
  /** 中文全名（"粮食"） */
  name: string;
  /** 一个字的简称，印在 HUD 徽章和按钮上（"粮"） */
  short: string;
  /** HUD 徽章的主色 */
  color: string;
  summary: string;
}

export const RESOURCES: ResourceDef[] = [
  {
    id: GOLD,
    name: '金币',
    short: '金',
    color: '#b8862b',
    summary: '通用通货：升级城市、造兵、修建筑都要它。原版唯一流通的资源。',
  },
  {
    id: 'food',
    name: '粮食',
    short: '粮',
    color: '#5f8f3e',
    summary: '生物单位的粮食：活人要吃饭，马也要。机械和建筑不吃它，改吃建材。',
  },
  {
    id: 'material',
    name: '建材',
    short: '材',
    color: '#6b7280',
    summary: '建材：盖房子、造投石机和船用的东西。木头、石头最后都算到这里。',
  },
];

export function resourceById(id: ResourceId): ResourceDef | undefined {
  return RESOURCES.find((r) => r.id === id);
}

/** 资源名（给日志和提示用）；未注册的 id 原样返回，方便扩展自己带名字 */
export function resourceName(id: ResourceId): string {
  return resourceById(id)?.name ?? id;
}

/** 一个字的简称 */
export function resourceShort(id: ResourceId): string {
  return resourceById(id)?.short ?? id;
}

export interface PlayerResources {
  gold: number;
  res?: Partial<Record<ResourceId, number>>;
}

/** 读某方某种资源的余额 */
export function resOf(p: PlayerResources, id: ResourceId): number {
  if (id === GOLD) return p.gold;
  return p.res?.[id] ?? 0;
}

/** 加/减资源。减少不会变成负数——调用方应该先用 canPay 问一句。 */
export function addRes(p: PlayerResources, id: ResourceId, n: number): void {
  if (!n) return;
  if (id === GOLD) {
    p.gold = Math.max(0, p.gold + n);
    return;
  }
  const res = (p.res ??= {});
  res[id] = Math.max(0, (res[id] ?? 0) + n);
}

/** 一份价格表（id → 数量），金币也在里面 */
export type ResourceCost = Partial<Record<ResourceId, number>>;

/** 付得起吗 */
export function canPay(p: PlayerResources, cost: ResourceCost): boolean {
  for (const [id, n] of Object.entries(cost)) {
    if ((n ?? 0) > 0 && resOf(p, id) < (n as number)) return false;
  }
  return true;
}

/** 扣钱。只扣得起的部分不会被扣成负数——外部一定要先 canPay */
export function payRes(p: PlayerResources, cost: ResourceCost): void {
  for (const [id, n] of Object.entries(cost)) {
    if ((n ?? 0) > 0) addRes(p, id, -(n as number));
  }
}

/** 还差多少（给"资源不足"的提示用）；都够就返回空表 */
export function missingRes(p: PlayerResources, cost: ResourceCost): ResourceCost {
  const out: ResourceCost = {};
  for (const [id, n] of Object.entries(cost)) {
    const need = n ?? 0;
    if (need <= 0) continue;
    const have = resOf(p, id);
    if (have < need) out[id] = need - have;
  }
  return out;
}

/** 把一份价格印成人话："60 金 40 粮"，只用写非零项 */
export function costLabel(cost: ResourceCost): string {
  const parts: string[] = [];
  for (const [id, n] of Object.entries(cost)) {
    if (!n || n <= 0) continue;
    parts.push(`${n} ${resourceShort(id)}`);
  }
  return parts.length > 0 ? parts.join(' ') : '免费';
}

/** 资源不足的中文提示："粮食缺 12" */
export function missingLabel(p: PlayerResources, cost: ResourceCost): string {
  const miss = missingRes(p, cost);
  const parts = Object.entries(miss).map(([id, n]) => `${resourceName(id)}缺 ${n}`);
  return parts.length > 0 ? parts.join('，') : '';
}

/**
 * 这个兵种是"活的"吗。
 *
 * 三条线索按优先级：显式写了 bio 就用它；建筑、机械、水上单位一律算非生物；
 * 其余都算活的。做成推断而不是逼两百多个兵种条目标注一遍，
 * 是因为"会动的都是活人"这个默认对 95% 的兵都成立，剩下 5% 才需要写一行。
 */
export function isBioUnit(def: UnitTypeDef): boolean {
  if (typeof def.bio === 'boolean') return def.bio;
  if (def.category === 'building') return false;
  if (def.domain === 'water') return false;
  if (def.abilities?.includes('machine')) return false;
  return true;
}

/** 初始资源：只给金币，其它资源从 0 开始 */
export function startingResources(gold: number): PlayerResources {
  return { gold };
}

/** `{ food: 3 }` → 只保留正数的干净表（避免到处出现 0 值） */
export function cleanCost(cost: ResourceCost): ResourceCost {
  const out: ResourceCost = {};
  for (const [id, n] of Object.entries(cost)) {
    if (n && n > 0) out[id] = n;
  }
  return out;
}

/** 两方资源表都补齐（读档时用）：缺 res 字段的旧存档等价于"只有金币" */
export function normalizePlayerResources(p: { gold: number; res?: Partial<Record<ResourceId, number>> }): void {
  if (p.res) return;
  p.res = {};
}

/** 便于测试与调试：把玩家的资源打成一行 */
export function resourceSnapshot(players: Record<PlayerId, PlayerResources>): string {
  return (['A', 'B'] as PlayerId[])
    .map((p) => {
      const extra = Object.entries(players[p].res ?? {})
        .filter(([, n]) => (n ?? 0) > 0)
        .map(([id, n]) => `${resourceShort(id)} ${n}`);
      return `${p}: 金 ${players[p].gold}${extra.length ? ' ' + extra.join(' ') : ''}`;
    })
    .join(' | ');
}
