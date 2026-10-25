/**
 * 自定义兵种库。
 *
 * 存在 localStorage 里，和内置兵种表完全分开：
 * 内置的永远只读（那是平衡基准），自定义的一律带 `c_` 前缀。
 * 想改内置兵种的手感，就"复制一份再改"，这样你随时能回到原版对照。
 */

import type { UnitTypeDef } from './types.ts';
import { isRecord, isUnitTypeDef } from './validation.ts';

const KEY = 'warchess:custom-units:v1';
export const CUSTOM_PREFIX = 'c_';

export function loadCustomUnits(): Record<string, UnitTypeDef> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return {};
    // 只收下结构完整的
    const out: Record<string, UnitTypeDef> = {};
    for (const [id, def] of Object.entries(parsed)) {
      if (id.startsWith(CUSTOM_PREFIX) && isUnitTypeDef(def) && def.id === id) {
        out[id] = def;
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveCustomUnits(units: Record<string, UnitTypeDef>): boolean {
  try {
    if (!isRecord(units) || !Object.entries(units).every(([id, def]) =>
      id.startsWith(CUSTOM_PREFIX) && isUnitTypeDef(def) && def.id === id)) return false;
    localStorage.setItem(KEY, JSON.stringify(units));
    return true;
  } catch {
    return false;
  }
}

export function upsertCustomUnit(def: UnitTypeDef): boolean {
  if (!isUnitTypeDef(def) || !def.id.startsWith(CUSTOM_PREFIX)) return false;
  const all = loadCustomUnits();
  all[def.id] = def;
  return saveCustomUnits(all);
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
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || parsed.kind !== 'warchess-units' || parsed.version !== 1
      || !isRecord(parsed.units)) return 0;
    const all = loadCustomUnits();
    const imported = Object.entries(parsed.units)
      .filter((entry): entry is [string, UnitTypeDef] => isUnitTypeDef(entry[1]) && entry[1].id === entry[0]);
    const ids = new Map<string, string>();
    // 先分配全部 id，第二遍再重写建造清单中的相互引用。
    for (const [id, def] of imported) {
      const fresh = nextCustomId(all);
      ids.set(id, fresh);
      all[fresh] = { ...structuredClone(def), id: fresh };
    }
    for (const fresh of ids.values()) {
      const def = all[fresh]!;
      if (def.builds) def.builds = def.builds.map((id) => ids.get(id) ?? id);
    }
    return imported.length > 0 && saveCustomUnits(all) ? imported.length : 0;
  } catch {
    return 0;
  }
}
