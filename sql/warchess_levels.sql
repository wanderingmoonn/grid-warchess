-- 玩家分享的关卡库（编辑器 →「管理」→「上传到云端」）
--
-- 什么时候要执行这个文件：想让别人玩到你做的关卡时，一次性执行。
-- 不执行也不影响任何事：本机的关卡、导出/导入 .json 全都照常，
-- 上传/浏览会明说"关卡库还没开通"。
--
-- 和 warchess_maps 的关系：同一套口径，别照抄 warchess_reports 那张表。
--   · 报告表是"只写不读"；这张表是"公开读、提交待审"；
--   · 安全边界不放在权限上，放在**校验**上：客户端只认 validateLevel 放行的数据。
--
-- 为什么不把关卡拆成列（地图是拆的）：关卡会继续长字段（事件、胜负、AI 参数……）。
-- 拆列意味着以后每加一个字段都要改表结构；整份存进 data(jsonb) 就不用。
-- 只有"列表要显示"的几个维度留在列上（尺寸 / 几家 / 事件数），方便排序和筛选。
--
-- ⚠️ 审核闸门靠两句话的配合（改权限时别拆开）：
--   · 读策略 `using (listed)` —— 未放行的行对所有人不可见（包括作者）；
--   · 插入策略要求 `listed = false` —— 客户端**没法**自己把关卡设成公开。
-- 放行只能在控制台/管理员身份下做，见 `warchess_levels_review.sql`。
-- 如果哪天有人把插入策略改松，审核就形同虚设：任何人 open 一段脚本插一行 listed=true
-- 就绕过了整个流程。

create table if not exists public.warchess_levels (
  id          bigserial   primary key,
  created_at  timestamptz not null default now(),
  name        text        not null,
  author      text,
  -- 列表要显示的维度，从 data 里提出来，避免每次都解 jsonb
  w           smallint    not null,
  h           smallint    not null,
  seats       smallint    not null default 2,
  events      smallint    not null default 0,
  -- 整份 LevelDef（不含本机的 user: id）。只存数据，没有任何脚本或 URL
  data        jsonb       not null,
  -- 审核闸门：false = 还在队列里，只有 true 才出现在「别人的关卡」中
  listed      boolean     not null default false
);

create index if not exists warchess_levels_created_idx
  on public.warchess_levels (created_at desc);

-- 审核队列按"没放行的、最新的在前"扫
create index if not exists warchess_levels_pending_idx
  on public.warchess_levels (created_at desc)
  where not listed;

alter table public.warchess_levels enable row level security;

-- 读：只给放行过的
drop policy if exists warchess_levels_read on public.warchess_levels;
create policy warchess_levels_read on public.warchess_levels
  for select using (listed);

-- 写：谁都能**提交**一份，但只能是待审核的（listed = false）。
-- 形状校验在客户端做（src/core/level.ts 的 validateLevel），这里挡的是
-- 明显不成立的尺寸/名字，以及"自己给自己放行"这条路。
drop policy if exists warchess_levels_insert on public.warchess_levels;
create policy warchess_levels_insert on public.warchess_levels
  for insert with check (
    listed = false
    and w between 8 and 40 and h between 8 and 40
    and seats between 2 and 4
    and events between 0 and 999
    and length(name) between 1 and 24
    and length(data::text) <= 262144
  );

grant select, insert on public.warchess_levels to anon, authenticated;
grant usage, select on sequence public.warchess_levels_id_seq to anon, authenticated;
