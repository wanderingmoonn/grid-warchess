-- 局面快照表（「反馈」按钮上传的现场）
--
-- 和 warchess_reports 是两张表，别合并：
--   · reports  —— 匿名平衡数据，不带名字/坐标/流水；
--   · snapshots —— 完整局面 + 最近日志（含名字与坐标），目的是复现问题。
-- 混成一张，"匿名"这句话立刻失效，分析查询也会把 bug 单算进胜率里。
--
-- 什么时候执行：想收快照时执行一次。不执行也不影响玩——界面会明说
-- "收集端还没开通"，并把「复制 JSON」留在原地。
--
-- 设计同 reports：
--   1) 列出来的字段是给人查的（版本、回合、描述），整份快照再塞进 payload；
--   2) 只给 anon 发写权限，不给读权限（谁能读整张表，就等于谁都能看别人传的局面）。

create table if not exists public.warchess_snapshots (
  id             bigserial   primary key,
  created_at     timestamptz not null default now(),
  -- 快照格式版本（src/core/snapshot.ts 的 SNAPSHOT_VERSION）
  version        integer     not null,
  -- 游戏版本（package.json 的 version，构建时注入）
  build          text        not null default 'dev',
  -- 玩家自己写的一句话
  note           text        not null default '',
  seed           bigint      not null,
  turns          integer     not null,
  player_count   smallint,
  current_player text,
  winner         text,
  payload        jsonb       not null,
  -- 去重：同一局同一回合、同一句描述、同一分钟只留一条
  fingerprint    text        not null,
  -- 只用于限流分组的随机代号，不是身份
  client_id      text,
  campaign       text,
  -- 他同意的是哪一版说明
  consent        text        not null
);

create index if not exists warchess_snapshots_created_idx
  on public.warchess_snapshots (created_at desc);
create index if not exists warchess_snapshots_seed_idx
  on public.warchess_snapshots (seed);
create unique index if not exists warchess_snapshots_fp_idx
  on public.warchess_snapshots (fingerprint);

alter table public.warchess_snapshots enable row level security;

grant insert on public.warchess_snapshots to anon, authenticated;
grant usage, select on sequence public.warchess_snapshots_id_seq to anon, authenticated;

drop policy if exists warchess_snapshots_insert on public.warchess_snapshots;
create policy warchess_snapshots_insert on public.warchess_snapshots
  for insert to anon, authenticated
  with check (true);

-- 同样**故意没有** select 策略：整份局面里有人家的名字和坐标，
-- 谁都能顺着这张表拉下来是不行的。要做分析请用管理员连接（migrate 角色）。


-- ============================================================
-- 限流：一台机器刷三百条同样能把库填满
--
-- 和 reports 那套同一个思路，但**分开计数**：报表和快照不是一回事，
-- 找 bug 时连传十条很正常，而平衡数据不需要。
-- ============================================================

create or replace function public.warchess_snapshot_rate_limit()
returns trigger
language plpgsql
security definer
as $$
begin
  if (
    select count(*) from public.warchess_snapshots
    where client_id = new.client_id
      and created_at > now() - interval '1 hour'
  ) >= 40 then
    raise exception 'too many snapshots';
  end if;
  return new;
end;
$$;

drop trigger if exists warchess_snapshots_rate on public.warchess_snapshots;
create trigger warchess_snapshots_rate
  before insert on public.warchess_snapshots
  for each row execute function public.warchess_snapshot_rate_limit();
