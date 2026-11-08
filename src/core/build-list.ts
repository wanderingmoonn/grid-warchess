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
    /**
     * 查某个建筑的档位。传了它，就自动滤掉"高过这个工兵"的建筑。
     *
     * `builds` 白名单是"这一列工人会的手艺"，不等于"此刻盖得起来"：
     * 扩展会在开局往白名单里补条目（"能架桥的人就能修船坞"），于是二代的
     * 工匠手里挂着四代的造船厂——列出来、点下去弹"要四代的工匠"，
     * 看起来就像数据错了。
     *
     * 判据和规则层同一条：建筑时代 ≤ 建造者时代（见 rules.buildSiteError）。
     * 规则只写在这一个函数里，六个消费者各传一个查表函数即可，不会再跑偏。
     */
    eraOf?: (id: string) => number | undefined;
  } = {},
): BuildList {
  const exists = opts.exists ?? (() => true);
  const eraOf = opts.eraOf;
  const nameOf = opts.nameOf ?? ((id: string) => id);
  const builderEra = def.era ?? 0;
  const ids = (def.builds ?? []).filter(
    (id) => exists(id) && (!eraOf || (eraOf(id) ?? 0) <= builderEra),
  );
  return { ids, names: ids.map((id) => nameOf(id) ?? id) };
}
