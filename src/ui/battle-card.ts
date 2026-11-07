/**
 * 战报卡的界面层：一张盖住屏幕的卡 + 两个出口（存图、复制文字）。
 *
 * 为什么自己画 canvas 而不是"把 HTML 截成图"：把 DOM 转图要么引依赖（html2canvas），
 * 要么走 SVG foreignObject + drawImage——后者对外链字体、跨域图片、浏览器的
 * 安全策略都很敏感，一个环境不一样就白屏。卡面就这么几行字，2D 画布直接画，
 * 结果是确定的。
 *
 * jsdom 里没有 canvas（getContext 返回 null），所以"存成图片"那颗按钮在那种环境
 * 下会被收起来——界面用例只验结构和文案，不去碰像素。
 */
import { battleCardText, type BattleCardData } from '../core/battle-card.ts';

const W = 720;
const H = 560;

function roundRect(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * 按**像素宽**截断，不是按字数。
 *
 * 原来写的是 `slice(0, 33)`：中文 33 个字在 17px 下是 561px，能塞进 608 的宽度；
 * 可玩家名、城名里夹着英文和数字时，34 个字符可能只有 300px（留一片空白），
 * 也可能因为全角标点撑到 640px（压到卡片边上）。字数是猜的，量出来才是准的。
 */
function fitText(g: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (g.measureText(text).width <= maxW) return text;
  let cut = text;
  while (cut.length > 1 && g.measureText(`${cut}…`).width > maxW) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** 把卡画到画布上。返回 null = 这个环境没有 2D 画布（jsdom / 老浏览器） */
export function drawBattleCard(d: BattleCardData, doc: Document): HTMLCanvasElement | null {
  const canvas = doc.createElement('canvas');
  const g = canvas.getContext?.('2d');
  if (!g) return null;
  canvas.width = W;
  canvas.height = H;

  // 底：和游戏同一个米色，圆角 + 细边
  g.fillStyle = '#f2efe8';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#ffffff';
  roundRect(g, 24, 24, W - 48, H - 48, 18);
  g.fill();
  g.strokeStyle = '#ded8cc';
  g.lineWidth = 2;
  g.stroke();

  // 顶部色带：赢是红，输是灰蓝
  g.fillStyle = d.winner ? (d.iWon ? '#b8433a' : '#6b7280') : '#9a9287';
  roundRect(g, 24, 24, W - 48, 10, 5);
  g.fill();

  const pad = 56;
  g.textBaseline = 'top';

  g.fillStyle = '#6b6459';
  g.font = '600 16px system-ui, "Microsoft YaHei", sans-serif';
  g.fillText('时代与回旋镖 · 战报', pad, 62);

  // 标题：一句话说清结果。用「胜利/失败」而不是「我赢了/我输了」——
  // 这张卡是要转发出去的，别人看不到"我"是谁，第一人称在别人手里会读成他自己。
  g.fillStyle = '#2b2823';
  g.font = '800 40px system-ui, "Microsoft YaHei", sans-serif';
  const head = d.winner ? (d.iWon ? '胜利' : '失败') : '平局';
  g.fillText(head, pad, 90);

  /*
   * 破城回合：卡面上最想被看到的那一个，所以给最大字号。
   *
   * 三档要分清，别图省事合成一档：
   *   · 有胜负、破过城 → 大号数字（赢了写「破城」，输了写「对方破城」，
   *     因为那座城未必是我的——对方可能先拿了中立城，写「被破城」会撒谎）；
   *   · 有胜负、没破城 → 这局赢法不是攻城，写"撑到第几回合"；
   *   · 平局 → 没有"破城回合"这回事，只写打了多久。
   * 之前把平局也塞进第二档，`by` 会退化成"我"，卡上就出现了"对方破城"配着
   * 我自己那一刀——同一张卡自相矛盾。
   */
  const bigTurn = d.winner ? d.winTurn : null;
  if (bigTurn !== null) {
    g.fillStyle = d.iWon ? '#b8433a' : '#6b7280';
    g.font = '800 64px system-ui, "Microsoft YaHei", sans-serif';
    const num = `第${bigTurn}回合`;
    g.fillText(num, pad, 146);
    const wNum = g.measureText(num).width;
    g.fillStyle = '#9a9287';
    g.font = '500 20px system-ui, "Microsoft YaHei", sans-serif';
    g.fillText(d.iWon ? '破城' : '对方破城', pad + wNum + 12, 190);
  } else {
    g.fillStyle = '#6b6459';
    g.font = '600 22px system-ui, "Microsoft YaHei", sans-serif';
    g.fillText(d.winner ? `撑到第 ${d.turns} 回合` : `打了 ${d.turns} 回合，没分出胜负`, pad, 160);
  }

  // MVP
  g.fillStyle = '#faf8f4';
  roundRect(g, pad, 238, W - pad * 2, 78, 12);
  g.fill();
  g.fillStyle = '#9a9287';
  g.font = '600 14px system-ui, "Microsoft YaHei", sans-serif';
  g.fillText('MVP 兵种', pad + 20, 252);
  /*
   * 名字和右侧那串数字在同一行：先量右边的，再把名字压进剩下的宽度。
   * 反过来做（先写名字再看右边）在扩展兵种上会撞——"星界龙骑士"这类长名字
   * 一多，右侧的击杀数就叠在名字尾巴上，两边都看不清。
   */
  const mvpName = d.mvp ? d.mvp.name : '没有击杀';
  const mvpStat = d.mvp ? `击杀 ${d.mvp.kills} · 终局存活 ${d.mvp.alive}` : '';
  const statFont = '600 18px system-ui, "Microsoft YaHei", sans-serif';
  g.font = statFont;
  const statW = mvpStat ? g.measureText(mvpStat).width : 0;
  const nameMax = W - pad * 2 - 40 - statW - 24;
  g.fillStyle = '#2b2823';
  g.font = '700 26px system-ui, "Microsoft YaHei", sans-serif';
  g.fillText(fitText(g, mvpName, Math.max(60, nameMax)), pad + 20, 274);
  if (mvpStat) {
    g.fillStyle = '#6b6459';
    g.font = statFont;
    g.fillText(mvpStat, W - pad - 20 - statW, 280);
  }

  // 关键三步
  const innerW = W - pad * 2;
  g.fillStyle = '#9a9287';
  g.font = '600 14px system-ui, "Microsoft YaHei", sans-serif';
  g.fillText('关键三步', pad, 336);
  g.fillStyle = '#2b2823';
  g.font = '500 17px system-ui, "Microsoft YaHei", sans-serif';
  d.steps.slice(0, 3).forEach((line, i) => {
    const y = 360 + i * 30;
    // 超长就截断：卡面是给人扫一眼的，不是让人读小作文
    const prefix = `${i + 1}. `;
    const rest = fitText(g, line, innerW - g.measureText(prefix).width);
    g.fillText(`${prefix}${rest}`, pad, y);
  });

  // 页脚：双方比分 + 种子
  g.fillStyle = '#9a9287';
  g.font = '500 14px system-ui, "Microsoft YaHei", sans-serif';
  /*
   * 两边的比数之间要有**看得见的分隔**。
   *
   * 原来只用一个全角空格，两人局读起来是"我 9 兵 / 时代 5　电脑·高级 3 兵 / 时代 4"——
   * 扫一眼会以为是一整串。竖线是卡面上最便宜的分界，不比加行高更占地方。
   * 玩家名是自己起的，四人局四条拼起来能长到溢出，所以量着缩，别让字顶出卡片。
   */
  g.fillText(
    fitText(
      g,
      d.sides.map((x) => `${x.name} ${x.units} 兵 / ${x.cities} 城 / 时代 ${x.era}`).join('　|　'),
      innerW,
    ),
    pad,
    H - 90,
  );
  g.fillText(fitText(g, `${d.board} · 种子 ${d.seed} · v${d.build}`, innerW), pad, H - 66);

  return canvas;
}

export interface BattleCardHooks {
  /** 复制到剪贴板；返回 false = 这个环境复制不了（由调用方兜底提示） */
  onCopied?: () => void;
}

/**
 * 打开战报卡。返回关闭函数。
 *
 * 卡片挂在 body 上，不挂 #app：右侧面板每帧重写，挂进去会被冲掉——
 * 和教程卡片、首页是同一个理由。
 */
export function openBattleCard(
  data: BattleCardData,
  host: HTMLElement,
  hooks: BattleCardHooks = {},
): () => void {
  const doc = host.ownerDocument;
  const nav = doc.defaultView?.navigator as
    | (Navigator & { share?: (d: ShareData) => Promise<void>; canShare?: (d: ShareData) => boolean })
    | undefined;
  const canShare = typeof nav?.share === 'function';
  const layer = doc.createElement('div');
  layer.className = 'bc-mask';
  const canvas = drawBattleCard(data, doc);
  const imgUrl = canvas ? canvas.toDataURL('image/png') : '';

  layer.innerHTML = `
    <div class="bc-box" role="dialog" aria-label="战报卡">
      <div class="bc-head">
        <b>战报卡</b>
        <button class="bc-close" data-bc="close" type="button" title="关闭">×</button>
      </div>
      ${imgUrl ? `<img class="bc-img" alt="战报卡" src="${imgUrl}" />` : '<p class="bc-fallback"></p>'}
      <p class="hint bc-tip">${imgUrl ? '图片只在你这台机器上生成，不会上传到任何地方。' : '这个环境画不出图片，可以先复制文字。'}</p>
      <div class="bc-actions">
        ${imgUrl ? '<button class="btn btn-sm btn-primary" data-bc="save" type="button">存成图片</button>' : ''}
        ${canShare ? '<button class="btn btn-sm" data-bc="share" type="button">分享</button>' : ''}
        <button class="btn btn-sm" data-bc="copy" type="button">复制文字</button>
        <button class="btn btn-sm" data-bc="close" type="button">关闭</button>
      </div>
    </div>
  `;

  // 没有 canvas 的宿主（jsdom）用纯文本兜底，保证卡片不是空的
  const fallback = layer.querySelector<HTMLElement>('.bc-fallback');
  if (fallback) fallback.textContent = battleCardText(data);

  const close = (): void => {
    layer.remove();
    doc.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  doc.addEventListener('keydown', onKey);

  layer.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (el === layer) { close(); return; }
    const btn = el.closest<HTMLElement>('[data-bc]');
    if (!btn) return;
    const act = btn.dataset.bc;
    if (act === 'close') { close(); return; }
    if (act === 'save' && imgUrl) {
      const a = doc.createElement('a');
      a.href = imgUrl;
      a.download = `战报-${data.seed}-${data.turns}.png`;
      a.click();
      return;
    }
    if (act === 'share' && nav?.share) {
      /*
       * 系统分享面板（手机上才能真正把图发出去）。
       *
       * 有图的机型优先发图：战报卡的价值一半在图上，只发一行字等于没发。
       * `canShare` 不支持的浏览器会直接 reject，所以要先问一句再决定发什么。
       * 整个流程用 catch 吞掉异常——用户点"取消"也会走 reject，
       * 那不是错误，不该再弹一个"分享失败"。
       */
      const text = battleCardText(data);
      void (async () => {
        try {
          if (imgUrl && typeof File === 'function') {
            const blob = await (await fetch(imgUrl)).blob();
            const file = new File([blob], `战报-${data.seed}.png`, { type: 'image/png' });
            if (!nav.canShare || nav.canShare({ files: [file] })) {
              await nav.share!({ files: [file], text });
              return;
            }
          }
          await nav.share!({ title: '战报', text });
        } catch { /* 取消 / 不支持：静默 */ }
      })();
      return;
    }
    if (act === 'copy') {
      const text = battleCardText(data);
      const clip = doc.defaultView?.navigator?.clipboard;
      if (clip?.writeText) {
        void clip.writeText(text).then(() => hooks.onCopied?.());
      } else {
        // 老浏览器 / 非安全上下文：退回复选框，至少让人能手动复制
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        doc.body.appendChild(ta);
        ta.select();
        try { doc.execCommand?.('copy'); } catch { /* 复制不了就算了，文本已经选中 */ }
        ta.remove();
        hooks.onCopied?.();
      }
    }
  });

  host.appendChild(layer);
  layer.querySelector<HTMLButtonElement>('[data-bc="save"]')?.focus();
  return close;
}
