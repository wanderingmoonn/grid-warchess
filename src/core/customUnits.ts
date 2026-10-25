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
      all[fresh] = { ...def, id: fresh };
      count += 1;
    }
    saveCustomUnits(all);
    return count;
  } catch {
    return 0;
  }
}
