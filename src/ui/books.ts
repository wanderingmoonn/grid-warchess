/**
 * 规则书的书单。
 *
 * 规则书原来只有一本，扩展规则挤在第 14 章。现在拆成多册之后，
 * 「点规则书看什么」就成了一个真问题：核心规则永远相关；
 * 小型扩展合订本只在开了至少一条小型扩展时相关；
 * 每个大包的分册只在这个包被勾选时相关。
 *
 * 书单由本局的 `config.expansionIds` 算出来，所以联机房里两边看到的
 * 书单天然一致——规则以 id 记进存档，这是同一份事实。
 */

import { EXPANSIONS } from '../core/expansions.ts';

export interface ManualBook {
  /** 相对路径，从 index.html 所在目录起 */
  file: string;
  /** 书名（列表里显示的） */
  title: string;
  /** 一句话说明这本讲什么 */
  note: string;
}

/** 核心规则书的文件名。manual-small / manual-pack-* 都由 build-manual.ts 生成 */
const SMALL_FILE = 'manual-small.html';

export function manualBooks(enabled: string[]): ManualBook[] {
  const books: ManualBook[] = [
    {
      file: 'manual.html',
      title: '核心规则书',
      note: '回合流程、地形、战斗、经济、时代——不开任何扩展也成立的那部分',
    },
  ];

  const small = EXPANSIONS.filter((e) => e.scale !== 'large' && enabled.includes(e.id));
  if (small.length > 0) {
    books.push({
      file: SMALL_FILE,
      title: '扩展规则（小型）',
      note: `${small.length} 条已启用：${small.map((e) => e.name).join('、')}`,
    });
  }

  for (const e of EXPANSIONS) {
    if (e.scale !== 'large' || !enabled.includes(e.id)) continue;
    books.push({
      file: `manual-pack-${e.id}.html`,
      title: e.name,
      // summary 可能是一整段，列表里放不下；截到第一个句号
      note: e.summary.split('。')[0] ?? e.summary,
    });
  }

  return books;
}

/**
 * 书单选择弹窗。
 *
 * 只有一本书的时候调用方应该直接打开它，别为了形式多问一次；
 * 这个函数只在真的存在"看哪本"这个选择时才被调。
 */
export function openManualChooser(books: ManualBook[]): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';

  const close = () => mask.remove();
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });

  const open = (file: string) => {
    window.open(`./${file}`, '_blank', 'noopener');
    close();
  };

  mask.innerHTML = `
    <div class="modal modal-narrow">
      <div class="modal-head">
        <h2>规则书</h2>
        <p>这一局开了 ${books.length - 1} 个扩展，相关分册如下</p>
      </div>
      <div class="modal-body">
        <div class="book-list">
          ${books
            .map(
              (b) => `
            <button class="book-row" data-file="${b.file}">
              <b>${b.title}</b>
              <span>${b.note}</span>
            </button>`,
            )
            .join('')}
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-close>关闭</button>
      </div>
    </div>`;

  mask.querySelectorAll<HTMLElement>('.book-row').forEach((row) => {
    row.addEventListener('click', () => open(row.dataset.file ?? 'manual.html'));
  });
  mask.querySelector<HTMLElement>('[data-close]')?.addEventListener('click', close);

  document.body.appendChild(mask);
}
