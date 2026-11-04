/**
 * 体检：每个时代的兵种，和时代名对不对得上。
 *
 * 时代名 2026-11-04 改成按"技术代"命名（青铜 / 铁器 / 火器 / 蒸汽 / 机械化 / 信息化），
 * 于是"某个兵出现在哪一代"就成了可以拿史实核一遍的东西：
 * 青铜时代不该有铁甲重骑兵，蒸汽时代不该有半履带车，机械化时代不该有无人机。
 *
 * 输出按"来源 × 时代"分组，每条带 id / 名称 / 造价 / 射程 / 能力，方便逐行核。
 *
 * 用法：node --experimental-strip-types scripts/audit-era-units.ts [--era 3] [--only core|naval|air|pack]
 */
import { ERAS, UNIT_TYPES } from '../src/core/config.ts';
// 2026-11-04 之后包都合并了（时代军备 / 奇想 / 海军 / 空军），
// 所以这里不再逐个 import 包，而是按"注册表里的 id"取——顺带保证体检覆盖到新包。
import { EXPANSIONS, expansionById } from '../src/core/expansions.ts';
import type { UnitTypeDef } from '../src/core/types.ts';

const args = process.argv.slice(2);
const argOf = (n: string, d: string): string => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? (args[i + 1] as string) : d;
};
const onlyEra = Number(argOf('era', '0'));
const onlySrc = argOf('only', '');

interface Row { src: string; def: UnitTypeDef }
const rows: Row[] = [];
// 包的 units 可能是数组也可能是字典，统一按 Object.values 走（两种都能拿到定义）
const push = (src: string, units: unknown) => {
  for (const def of Object.values((units ?? {}) as Record<string, UnitTypeDef>)) rows.push({ src, def });
};
push('core', UNIT_TYPES);
// 每个扩展一组：源标签就用包 id，方便 --only 过滤（--only era-arms / naval / air / fantasy）
for (const e of EXPANSIONS) push(e.id, e.units);
// 第六时代底座（信息化）也算一组，上面的循环已经带上了；这里留一行说明它现在的位置
void expansionById('pack-contemporary');

const byEra = new Map<number, Row[]>();
for (const r of rows) {
  if (onlySrc && !r.src.startsWith(onlySrc)) continue;
  if (onlyEra && r.def.era !== onlyEra) continue;
  if (!byEra.has(r.def.era)) byEra.set(r.def.era, []);
  byEra.get(r.def.era)!.push(r);
}

for (const era of [...byEra.keys()].sort((a, b) => a - b)) {
  console.log(`\n════ 第 ${era} 时代 · ${ERAS[era - 1]?.name ?? '?'} ════`);
  for (const src of [...new Set(byEra.get(era)!.map((r) => r.src))].sort()) {
    const list = byEra.get(era)!.filter((r) => r.src === src);
    console.log(`  [${src}] ${list.length} 个`);
    for (const { def } of list.sort((a, b) => a.def.cost - b.def.cost)) {
      const bits = [
        `${String(def.cost).padStart(3)}金`,
        `${String(def.atk ?? 0).padStart(2)}攻`,
        `射${def.range}`,
        `移${def.move}`,
        def.maxHp ? `${def.maxHp}血` : '',
        def.abilities?.length ? `[${def.abilities.join(',')}]` : '',
      ].filter(Boolean);
      console.log(`      ${def.id.padEnd(22)} ${def.name.padEnd(10)} ${bits.join(' ')}`);
    }
  }
}
