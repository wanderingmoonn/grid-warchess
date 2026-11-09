/**
 * "这一下点击算不算选定了技能目标"。
 *
 * 单独抽出来是因为这里同时管两种技能，规则还不一样：
 *
 *   · 方向型（剑气纵横、御空）：只认施法者四邻那四块热区——四邻就是"往哪边"。
 *   · 选点型（传送阵「挪移」）：地图上**任意一格**都算落点，唯独自己脚下除外。
 *     技能那边会把"落点 = 自己"判成过载、而且**照扣灵石**，玩家手一抖点到
 *     自家阵上就白亏十块，所以这一格当"取消"处理。
 *
 * 以前这段直接写在点击回调里、并且无条件只看 `aimTiles`，于是传送阵也只能
 * 往身边一格挪——技能数据里的 `targeting: 'point'` 白写了。抽成函数之后，
 * 四种组合都能被测试钉住，不会有人手滑改回去。
 */
export function skillTargetPicked(opts: {
  targeting: 'point' | 'direction';
  /** 点到的这一格是不是施法者脚下 */
  onSelf: boolean;
  /** 方向型的四邻热区；选点型传空数组即可 */
  aimTiles: readonly number[];
  /** 点到的格索引 */
  cell: number;
}): boolean {
  if (opts.targeting === 'point') return !opts.onSelf;
  return opts.aimTiles.includes(opts.cell);
}
