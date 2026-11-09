/**
 * 单位数值指纹：用来判断**卡牌先验表有没有过期**。
 *
 * ---------------------------------------------------------------
 * 为什么需要
 * ---------------------------------------------------------------
 * `card-prior.table.ts` 是一张**快照**：2026-11-08 那 400 局跑出来的残差。
 * 它记的是"这张卡当时赢多少"，不是"这张卡为什么赢"。所以只要动了数值
 * （弩兵攻 16→19、炼金术士 165→240），表里的残差就变成旧世界的结论，
 * 而被它加权的是新世界的卡——两套信号互相矛盾，比没有先验更糟。
 *
 * 靠人记住"改数值之后要重跑"是不可靠的（这个项目已经栽过：`WB_RULER` 的
 * 50%→35% 就写在注释里，还是又跑了 400 局才翻出来）。所以让表**自己失效**：
 *
 *   · 生成时把当时那批卡的数值指纹写进表头；
 *   · 运行时重新算一遍，对不上就把先验关掉（并在控制台说明原因）；
 *   · 测试里再断言一次——改数值忘了重跑，`npm run test:rules` 直接红。
 *
 * ---------------------------------------------------------------
 * 口径
 * ---------------------------------------------------------------
 * 只哈希**影响强度的字段**，不哈希 name/short/描述/图标这类文案：
 * 改个名字不该让先验失效，改一点攻击力必须失效。
 *
 * 覆盖的是"全扩展单位表"（`UNIT_TYPES` + 所有扩展的兵），**不是**某一局的
 * 兵种表：否则关掉一个扩展就会让指纹对不上，先验被无辜关掉。
 */

import { UNIT_TYPES } from '../../src/core/config.ts';
import { EXPANSIONS } from '../../src/core/expansions.ts';
import { expansionUnitsFor } from '../../src/core/setup.ts';
import type { UnitTypeDef } from '../../src/core/types.ts';

/**
 * 参与指纹的字段。
 *
 * 挑的标准是"这条改了，这张卡的强弱会变"：数值、代价、时代、地形域、
 * 能力列表（掠空/潜行这类能改变交战关系的都在 abilities 里）。
 * `vision`/`move` 也留着——它们不直接进 `draftValueOf`，但确实改变实战表现。
 */
const FIELDS = [
  'era',
  'category',
  'cost',
  'atk',
  'armor',
  'maxHp',
  'range',
  'vision',
  'move',
  'domain',
  'splash',
  'airLayer',
  'abilities',
  'income',
  'incomeByTerrain',
  'yield',
  'builds',
] as const;

/** 所有扩展的兵 + 本体兵种（只看数值，和不传扩展的对局无关） */
export function fullUnitCatalog(): Record<string, UnitTypeDef> {
  const allIds = EXPANSIONS.map((e) => e.id);
  return { ...UNIT_TYPES, ...expansionUnitsFor(allIds) };
}

/** 一条 def → 参与指纹的紧凑字符串（字段顺序固定，数组保持原顺序） */
function canonical(def: UnitTypeDef): string {
  const parts: string[] = [];
  for (const f of FIELDS) {
    const v = (def as unknown as Record<string, unknown>)[f];
    if (v === undefined) { parts.push('-'); continue; }
    if (Array.isArray(v)) parts.push(v.map((x) => String(x)).join('+'));
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      parts.push(Object.keys(o).sort().map((k) => `${k}=${String(o[k])}`).join(','));
    } else parts.push(String(v));
  }
  return parts.join('|');
}

/** FNV-1a 32 位：不需要密码学强度，只要"改了就不一样" */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 给定一批卡 id，算它们的数值指纹。
 *
 * id 先排序再拼，所以入参顺序不影响结果；表里没有的 id 记作 `missing`，
 * 这样"这张卡被删了"也能被指纹发现。
 */
export function unitDigest(ids: readonly string[], catalog?: Record<string, UnitTypeDef>): string {
  const cat = catalog ?? fullUnitCatalog();
  const sorted = [...new Set(ids)].sort();
  const body = sorted
    .map((id) => {
      const def = cat[id];
      if (!def) return `${id}:missing`;
      return `${id}:${canonical(def)}`;
    })
    .join('\n');
  return fnv1a(body);
}
