/**
 * 「这个建造单位能盖什么」的唯一口径。
 *
 * 以前这句话在三处各写各的：规则书只报数量、属性卡查本局兵种表、面板把查不到的
 * 直接丢掉。结果同一局里能出现"可建 10 种"配 8 个按钮、或者冒出一个英文 id。
 * 现在名单只由这里生成，三个消费者各自只负责提供"去哪查名字 / 哪些算存在"。
 *
 * 为什么要分 `ids` 和 `names`：面板要的是兵种定义（去排按钮），规则书和属性卡
 * 要的是中文名。两者必须来自同一次过滤，否则数量又会对不上。
 *
 * 为什么不收 `GameState`：规则书是离线生成的脚本，手里没有一局游戏，只有一张
 * 静态兵种表。把"查名字"和"判存在"交给调用方，这份代码就能两边共用。
 */
import type { UnitTypeDef } from './types.ts';

export interface BuildList {
  /** 过滤后确实存在的建筑 id，顺序与兵种数据里的 builds 一致 */
  ids: string[];
  /** 与 ids 一一对应的显示名 */
  names: string[];
}

export function buildListOf(
  def: UnitTypeDef,
  opts: {
    /** 查不到名字时返回 undefined，由这里兜底成 id */
    nameOf?: (id: string) => string | undefined;
    /** 本局/本册里这个建筑存不存在。不传 = 全算存在（规则书用） */
    exists?: (id: string) => boolean;
  } = {},
): BuildList {
  const exists = opts.exists ?? (() => true);
  const nameOf = opts.nameOf ?? ((id: string) => id);
  const ids = (def.builds ?? []).filter(exists);
  return { ids, names: ids.map((id) => nameOf(id) ?? id) };
}
