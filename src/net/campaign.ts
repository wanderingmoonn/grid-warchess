/**
 * 批次码：这一份数据是"哪一批邀请带来的"。
 *
 * 为什么要它：邀请网友参与采集之后，最需要的不是防作弊，而是**能和某一批数据切割**。
 * 某个群里有人刷了三百条、或者某个版本改坏了、或者某次邀请的对象根本不是目标人群，
 * 你得能一次性把那一批隔离出去，而不是对着整张表一条条猜。
 *
 * 它不是什么（这点必须写死）：
 *   · 不是身份。同一个批次可以有很多人，一个人也可能出现在多个批次里；
 *   · 不是凭证。不校验、不限额，伪造了也不会带来额外权限——它只是给数据贴的来源标签；
 *   · 不进报告正文。它是数据库的一列，玩家下载的那份 JSON 里没有它。
 *
 * 形状跟着数据库的 CHECK 走：`^[a-z0-9][a-z0-9-]{0,23}$`。
 * 不合法就当没有——宁可不贴标签，也不要往库里塞一个会被约束拒掉的字符串，
 * 那会让整份报告上传失败（为了一个标签丢掉一份数据，不划算）。
 */

const KEY = 'warchess.campaign';
/** 跟 sql/warchess_reports.sql 里的 CHECK 完全一致 */
const PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * 把邀请链接上的 `?campaign=` 收拾成合法值。
 *
 * 单独抽出来是为了能测：它只吃一个字符串，不碰 location、不碰存储。
 */
export function normalizeCampaign(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 24);
  // 两头的横线都去掉：约束要求首字符是字母或数字，尾部的 'a-' 也没人想要
  const trimmed = text.replace(/^-+/, '').replace(/-+$/, '');
  if (!trimmed) return null;
  return PATTERN.test(trimmed) ? trimmed : null;
}

let cached: string | null | undefined;

/**
 * 当前批次码：优先用 URL 上的，其次用上次记下的。
 *
 * 记在本机是有意的：邀请链接往往只点一次，之后玩家从收藏夹或者首页进来，
 * URL 上就没有 `?campaign=` 了。不记的话，同一位网友第二局之后的报告全都没有来源标签，
 * 而那恰恰是样本的主体。
 */
export function campaignCode(): string | null {
  if (cached !== undefined) return cached;
  try {
    const fromUrl = normalizeCampaign(new URLSearchParams(location.search).get('campaign'));
    if (fromUrl) {
      localStorage.setItem(KEY, fromUrl);
      cached = fromUrl;
      return cached;
    }
    cached = normalizeCampaign(localStorage.getItem(KEY));
    return cached;
  } catch {
    // 隐私模式 / 没有 location：这一局不贴标签，不影响上传
    cached = null;
    return null;
  }
}

/** 测试用：忘掉缓存 */
export function resetCampaignCache(): void {
  cached = undefined;
}
