/**
 * 长列表收纳：只露前几行，剩下的折进一行「还有 N 项」。
 *
 * 为什么要它：产兵列表在后期会长到两三百行（时代 8、全扩展实测 240 种），
 * 侧栏整条滚不完。但**不能靠"少列一些"来解决**——这个项目一贯的规矩是
 * "冷却中的技能是灰按钮，不是消失"：藏起来的东西，玩家会以为是没了。
 * 所以这里收起来但**照样计数**，标题上写着还有多少个，点开就全在。
 *
 * 两个数字分开管：
 *   · `FOLD_TOTAL`：整个列表超过这么多条才启动收纳。早期一座城只有二十几种兵，
 *     那时候折叠只是让人多点一次，所以一条也不收。
 *   · `FOLD_KEEP`：启动之后每组留几行。分组是按类别（战斗/经济/建造）来的，
 *     所以不会出现"经济兵被折没了"——每组各自留头几行。
 *
 * 展开状态不归这里管：面板每帧整块重建，记在 DOM 上的 `open` 一刷新就没了，
 * 得由调用方（main.ts 的 openFolds）记着，渲染时再传回来。
 */

/** 整个列表超过这个条数才收纳。早期局不受影响 */
export const FOLD_TOTAL = 30;

/** 收纳启动后，每一组留几行 */
export const FOLD_KEEP = 12;

/** 这一次渲染，每组最多露几行（返回 Infinity 表示不收纳） */
export function foldLimit(total: number): number {
  return total > FOLD_TOTAL ? FOLD_KEEP : Number.POSITIVE_INFINITY;
}

/** 只处理 HTML 属性里会出事的三个字符；键都是内部 id，不需要完整转义 */
function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * 把一组已经渲染好的行收纳起来。
 *
 * `key` 必须**跨帧稳定**（比如 `recruit:<城 id>:<类别>`）：它就是"这一组展开过没有"
 * 的记账名。用序号当 key 的话，换一座城就会被上一座城的展开状态串味。
 */
export function foldRows(
  rows: readonly string[],
  opts: { key: string; open: boolean; limit: number; noun?: string },
): string {
  const { key, open, limit } = opts;
  if (rows.length <= limit) return rows.join('');
  const rest = rows.slice(limit);
  return (
    rows.slice(0, limit).join('') +
    `<details class="list-fold" data-fold="${attr(key)}"${open ? ' open' : ''}>` +
    `<summary class="list-fold-head">还有 ${rest.length} ${opts.noun ?? '项'}</summary>` +
    // 里面还得是一个 .recruit-list：按钮的间距、宽度都靠它，光靠外面那层会挤成一行
    `<div class="recruit-list">${rest.join('')}</div>` +
    `</details>`
  );
}
