/**
 * 这台浏览器的一个随机代号。
 *
 * 干什么用的：**只用来限流**。对局报告是可以匿名提交的，所以服务端没有
 * 任何"你是谁"的信息，也就没法拦"同一个来源一小时传三百条"。给每个浏览器
 * 发一个随机串带上去，服务端就能按它计数——一个小时内从同一台机器传超过
 * 几十条，多半不是人在打。
 *
 * 三条边界，别误会它的作用：
 *   1. 它**不是身份**。换浏览器、清缓存、开无痕，都会换一个新的；它也不进
 *      报告正文，只在那一列里，用来数数。
 *   2. 它**不防坏人**：改一下 localStorage 就能绕。真要抗刷得靠 IP 或
 *      账号，这套静态托管环境给不了。
 *   3. 它**不写进报告**。上传失败要「复制报告 / 下载 .json」时，导出的东西
 *      里没有这个 id——玩家手里那份和他交上去的内容是一致的。
 */

const KEY = 'warchess.client.id';

/** 进程内缓存：一次会话里不用反复读 localStorage */
let cached: string | null = null;

function randomId(): string {
  // 16 个字节够了：它只用来分组计数，不需要抗碰撞
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

export function clientId(): string {
  if (cached) return cached;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && saved.length >= 8) {
      cached = saved;
      return saved;
    }
    const fresh = randomId();
    localStorage.setItem(KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    // 隐私模式 / 存储被禁：这次会话用一个临时 id。
    // 后果只是"限流这一层对它不生效"，不影响上传。
    cached ??= randomId();
    return cached;
  }
}

/** 测试用：忘掉缓存（同进程里换一个 id） */
export function resetClientIdCache(): void {
  cached = null;
}
