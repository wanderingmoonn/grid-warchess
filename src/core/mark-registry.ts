/**
 * 留痕种类总表：各扩展贡献的水雷、地雷、火场……合成一张查询表。
 *
 * 和 ability-registry.ts 同一个模式：这里只做"合并与查询"，不放实现。
 * 实现跟着扩展走（谁家的东西谁家管），引擎（marks.ts）只认这张表。
 *
 * 为什么不看"这一局勾了哪些扩展"：和兵种能力同一条理由——留痕是内容的
 * 一部分。真要按扩展过滤，那是"这一局允许出现哪些"的判定，属于规则层，
 * 不该混进注册表（否则存档里一条奇想包的水雷，关掉扩展之后就查不到了，
 * 表现出来是"地图上有个格子一直炸人，却不知道那是什么"）。
 */

import { EXPANSIONS } from './expansions.ts';
import { allMarkKinds, markKindOf, registerMarkKind } from './marks.ts';
import type { MarkKindDef } from './marks.ts';

for (const e of EXPANSIONS) {
  for (const k of e.marks ?? []) {
    registerMarkKind(k);
  }
}

export { allMarkKinds, markKindOf };
export type { MarkKindDef };
