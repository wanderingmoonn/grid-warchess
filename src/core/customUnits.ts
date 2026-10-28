/**
 * 自定义兵种库。
 *
 * 存在 localStorage 里，和内置兵种表完全分开：
 * 内置的永远只读（那是平衡基准），自定义的一律带 `c_` 前缀。
 * 想改内置兵种的手感，就"复制一份再改"，这样你随时能回到原版对照。
 */

import type { UnitTypeDef } from './types.ts';

const KEY = 'warchess:custom-units:v1';
export const CUSTOM_PREFIX = 'c_';

/**
 * 把旧的"整数抗性"折成倍率。
 *
 * 背景：`resist` 原来记的是**平减点数**（水元素写 4 = 少挨 4 点），
 * 2026-10-28 改结算顺序时改成了**倍率**（0~1 打折）。内置表当场改了，
 * 但玩家自己存的兵种还在 localStorage 里，那些 4 在新算法下就是"受四倍伤害"——
 * 不迁移的话，谁改过抗性，谁的兵就会变成玻璃。
 *
 * 折算公式 `1/(1+v*0.1)`：4 → 0.714（和内置水元素改的 0.7 基本对齐）、
 * 2 → 0.833、10 → 0.5。取倒数是有意的：抗性越高，再加一点的边际收益越小，
 * 不会出现"点数堆到 20 直接免疫"。
 */
export function legacyResistToMultiplier(v: number): number {
  if (!Number.isFinite(v) || v <= 0) return 1;
  if (v < 1) return v; // 已经是倍率，别动
  return Math.min(0.95, Math.max(0.2, 1 / (1 + v * 0.1)));
}

/**
 * 修正一个兵种定义里的抗性。没改动就返回 null（省得白白复制对象）。
 */
export function normalizeUnitResist(def: UnitTypeDef): UnitTypeDef | null {
  const src = def.resist;
  if (!src) return null;
  const next: Partial<Record<string, number>> = {};
  let changed = false;
  for (const [el, v] of Object.entries(src)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const mul = legacyResistToMultiplier(v);
    next[el] = mul;
    if (mul !== v) changed = true;
  }
  return changed ? { ...def, resist: next as UnitTypeDef['resist'] } : null;
}

/**
 * 就地修正一整张兵种表（自定义库、以及老存档里内嵌的 unitTypes 都用它）。
 * 幂等：第二次调用返回 false。返回 true 表示**真的改过**，调用方可以借此决定要不要写回。
 */
export function normalizeUnitTypes(defs: Record<string, UnitTypeDef>): boolean {
  let changed = false;
  for (const [id, def] of Object.entries(defs)) {
    const fixed = normalizeUnitResist(def);
    if (fixed) {
      defs[id] = fixed;
      changed = true;
    }
  }
  return changed;
}

export function loadCustomUnits(): Record<string, UnitTypeDef> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, UnitTypeDef>;
    if (!parsed || typeof parsed !== 'object') return {};
    // 只收下结构完整的
    const out: Record<string, UnitTypeDef> = {};
    for (const [id, def] of Object.entries(parsed)) {
      if (def && def.id === id && typeof def.cost === 'number' && typeof def.atk === 'number') {
        out[id] = def;
      }
    }
    // 顺手把老格式的抗性折成倍率：改过就写回，之后每次读都是干净的
    if (normalizeUnitTypes(out)) saveCustomUnits(out);
    return out;
  } catch {
    return {};
  }
}

export function saveCustomUnits(units: Record<string, UnitTypeDef>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(units));
  } catch {
    // 隐私模式下写不进去，忽略
  }
}

export function upsertCustomUnit(def: UnitTypeDef): void {
  const all = loadCustomUnits();
  all[def.id] = def;
  saveCustomUnits(all);
}

export function removeCustomUnit(id: string): void {
  const all = loadCustomUnits();
  delete all[id];
  saveCustomUnits(all);
}

/** 生成一个不冲突的自定义 id */
export function nextCustomId(existing: Record<string, UnitTypeDef>): string {
  let n = 1;
  while (existing[`${CUSTOM_PREFIX}${n}`]) n += 1;
  return `${CUSTOM_PREFIX}${n}`;
}

/** 复制一个兵种作为自定义草稿 */
export function cloneAsCustom(src: UnitTypeDef, existing: Record<string, UnitTypeDef>): UnitTypeDef {
  return {
    ...structuredClone(src),
    id: nextCustomId(existing),
    name: `${src.name}·改`,
  };
}

/** 空白草稿 */
export function blankUnit(existing: Record<string, UnitTypeDef>): UnitTypeDef {
  return {
    id: nextCustomId(existing),
    name: '新兵种',
    short: '新',
    era: 1,
    category: 'combat',
    cost: 30,
    move: 3,
    atk: 10,
    armor: 2,
    maxHp: 25,
    range: 1,
    vision: 3,
  };
}

/** 导入/导出的文本格式，方便发给别人 */
export function exportCustomUnits(): string {
  return JSON.stringify({ kind: 'warchess-units', version: 1, units: loadCustomUnits() });
}

export function importCustomUnits(text: string): number {
  try {
    const parsed = JSON.parse(text) as { kind?: string; units?: Record<string, UnitTypeDef> };
    if (parsed.kind !== 'warchess-units' || !parsed.units) return 0;
    const all = loadCustomUnits();
    let count = 0;
    for (const def of Object.values(parsed.units)) {
      if (!def) continue;
      // 导入的 id 一律重编号，避免覆盖本地已有的
      const fresh = nextCustomId(all);
      const withId: UnitTypeDef = { ...def, id: fresh };
      // 别人用旧版导出的文件里，抗性还是整数点数
      all[fresh] = normalizeUnitResist(withId) ?? withId;
      count += 1;
    }
    saveCustomUnits(all);
    return count;
  } catch {
    return 0;
  }
}
