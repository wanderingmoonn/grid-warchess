/**
 * 规则书的书单。
 *
 * 规则书原来只有一本，扩展规则挤在第 14 章。拆成多册之后，
 * 「点规则书看什么」就成了一个真问题：核心规则永远相关；
 * 小型扩展合订本只在开了至少一条小型扩展时相关；大包的合册只在他开了
 * 其中至少一个包时相关。
 *
 * 归册的粒度是**玩法系列**，不是单个包：五个奇想包合成一本，时代兵备那几个包
 * （五个时代 + 第六代的底座与加料）合成一本。按包拆的代价是"同一段机制要印五遍，想在两个包里挑个兵得开五个
 * 标签页"——那和"别让无关内容占版面"的初衷正好相反。
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

/** 核心规则书的文件名。其它册都由 build-manual.ts 生成 */
const SMALL_FILE = 'manual-small.html';

/**
 * 合册：开了其中任一包，这本就上架。
 *
 * `prefix` 必须和 build-manual.ts 里的 BOOK_GROUPS 对齐。两边各写一份是刻意的：
 * 生成器决定"哪些包印进哪本"，这里决定"什么时候把这本书列出来"。
 * 合成一个常量会把两件事绑死，而分开写时最坏的情况只是多列一本——
 * 生成器已经保证不会产出空册。
 */
const GROUP_BOOKS: Array<{ prefix: string; file: string; title: string; note: string }> = [
  {
    prefix: 'fantasy-',
    file: 'manual-pack-fantasy.html',
    title: '奇幻扩展',
    note: '奇想五包合册——法则、骑士团、荒兽、秘法、英雄：兵种总表 + 机制词条',
  },
  {
    prefix: 'naval-',
    file: 'manual-pack-naval.html',
    title: '海战扩展',
    note: '海上力量两包合册——海战（E2~E5）+ 现代海军（E6）：船种总表、封锁与抢修、航母甲板接口',
  },
  {
    prefix: 'air-',
    file: 'manual-pack-air.html',
    title: '空军扩展',
    note: '空中力量两包合册——空军（E4~E5）+ 现代空军（E6）：机种总表、制空与对地、航母甲板接口',
  },
  {
    prefix: 'pack-',
    file: 'manual-pack-eras.html',
    title: '时代兵备',
    note: '六个时代的兵种扩充合册——古典、中世、火药、工业、二战、现代（底座 + 现代战争）：一张总表看全',
  },
];

export function manualBooks(enabled: string[]): ManualBook[] {
  const books: ManualBook[] = [
    {
      file: 'manual.html',
      title: '核心规则书',
      note: '回合流程、地形、战斗、经济、时代——不开任何扩展也成立的那部分',
    },
  ];

  // 只认配置里真有的 id：存档可能带着一个已经删掉的扩展
  const active = EXPANSIONS.filter((e) => enabled.includes(e.id));

  const small = active.filter((e) => e.scale !== 'large');
  if (small.length > 0) {
    books.push({
      file: SMALL_FILE,
      title: '扩展规则（小型）',
      note: `${small.length} 条已启用：${small.map((e) => e.name).join('、')}`,
    });
  }

  // 合册：一本顶原来好几本，所以 note 要写清"你这局开的是哪几个包"
  const grouped = new Set<string>();
  for (const g of GROUP_BOOKS) {
    const on = active.filter((e) => e.scale === 'large' && e.id.startsWith(g.prefix));
    if (on.length === 0) continue;
    for (const e of on) grouped.add(e.id);
    books.push({
      file: g.file,
      title: g.title,
      note: `${g.note}（已启用：${on.map((e) => e.name).join('、')}）`,
    });
  }

  // 剩下的单个大包（城郭与物料、季节与气候这类）仍各自一本
  for (const e of active) {
    if (e.scale !== 'large' || grouped.has(e.id)) continue;
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
        <p>按这一局启用的扩展列出相关分册；合册收的是同一套玩法的几个包</p>
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
