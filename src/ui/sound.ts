/**
 * 回合提示音。
 *
 * 为什么不用音频文件：一个 4KB 的 wav 也要走加载、解码、跨域、缓存这套流程，
 * 而这里只需要"叮咚两声"。用 WebAudio 现场合成，零资源、零延迟、可调音量。
 *
 * 浏览器的自动播放策略：AudioContext 必须在用户手势之后才能出声。
 * 这个提示音只在"对方结束回合、轮到你"时响，那时玩家一定已经点过棋盘或按钮，
 * 所以正常流程下不会被拦。被拦了也只是安静一次，catch 掉即可，不该弹错误。
 */

const KEY = 'warchess:chime:v1';

/** 五档，够用且不用滑块（点击循环比拖滑块在手机上更稳） */
export const CHIME_STEPS = [0, 0.25, 0.5, 0.75, 1] as const;

export function loadChimeVolume(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return 0.6;
    const v = Number(raw);
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.6;
  } catch {
    return 0.6;
  }
}

export function saveChimeVolume(v: number): void {
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    // 隐私模式下写不进去，忽略
  }
}

/** 下一档（0 → 0.25 → 0.5 → 0.75 → 1 → 0） */
export function nextChimeVolume(current: number): number {
  const i = CHIME_STEPS.findIndex((v) => v > current + 0.001);
  return i === -1 ? 0 : (CHIME_STEPS[i] as number);
}

export function chimeLabel(volume: number): string {
  return volume <= 0 ? '铃声 关' : `铃声 ${Math.round(volume * 100)}%`;
}

/**
 * 播一声"叮—咚"。
 *
 * 音高取 660 → 880（E5 → A5 的近似），两个正弦音各 0.22 秒、间隔 0.14 秒：
 * 上行音程听起来是"注意"，下行会像"结束"，而这里要的是"到你了"。
 */
export function playChime(volume: number): void {
  if (volume <= 0) return;
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const now = ctx.currentTime;
    const freqs = [660, 880];
    for (let i = 0; i < freqs.length; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freqs[i] as number;
      const t0 = now + i * 0.14;
      // 0.25 是把方波/正弦的听感压到"能听见但不炸耳"的经验值，
      // 再乘玩家设的音量；起音 20ms、衰减 200ms，避免爆音
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(volume * 0.25, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    }
    // 播完关掉 context，否则每个回合都会漏一个 AudioContext
    window.setTimeout(() => void ctx.close().catch(() => {}), 900);
  } catch {
    // 自动播放被拦、或者环境不支持（jsdom）——静默跳过，不影响对局
  }
}
