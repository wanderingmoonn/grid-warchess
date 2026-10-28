-- 对局报告收集表（「这局的数据要不要捐出来」上传到这里）
--
-- 什么时候要执行这个文件：想在云端收对局数据的时候，一次性执行。
-- 不执行也不影响玩：界面会明说"收集端还没开通"，并把「复制报告 / 下载 .json」
-- 留在原地，玩家可以把报告自己发出来。
--
-- 设计上有意的两条：
--   1) 列出来的字段是给人查的（种子、回合数、胜负、阵容），
--      整份报告再原样塞进 payload——以后加字段不用改表；
--   2) 只给 anon 发写权限，不给读权限：谁都能交一份，但没人能顺着这张表
--      把别人交的东西全拉下来。要做分析就用管理员连接（migrate 角色）查。

create table if not exists public.warchess_reports (
  id          bigserial primary key,
  created_at  timestamptz not null default now(),
  -- 报告格式版本（src/core/report.ts 的 REPORT_VERSION）
  version     integer     not null,
  seed        bigint      not null,
  board_w     smallint    not null,
  board_h     smallint    not null,
  turns       integer     not null,
  -- 'A' / 'B' / null（未分胜负）
  winner      text,
  expansions  text[]      not null default '{}',
  ai          jsonb       not null default '{}'::jsonb,
  sides       jsonb       not null default '[]'::jsonb,
  payload     jsonb       not null
);

create index if not exists warchess_reports_created_idx
  on public.warchess_reports (created_at desc);
create index if not exists warchess_reports_seed_idx
  on public.warchess_reports (seed);

alter table public.warchess_reports enable row level security;

-- GRANT 和 POLICY 是两道独立的门，只做 RLS 不 GRANT 会得到形似"策略失效"的 42501。
grant insert on public.warchess_reports to anon, authenticated;
grant usage, select on sequence public.warchess_reports_id_seq to anon, authenticated;

drop policy if exists warchess_reports_insert on public.warchess_reports;
create policy warchess_reports_insert on public.warchess_reports
  for insert to anon, authenticated
  with check (true);

-- 注意：这里**故意没有** select 策略。
-- 如果上传时报 42501、而上面两条都已经执行过，那多半是 SDK 的 insert 带了
-- returning（想拿回插入行），这时才需要把下面这条打开——
-- 代价是任何人都能读整张表，匿名数据也别指望它隐私，请自行权衡：
--
-- drop policy if exists warchess_reports_read on public.warchess_reports;
-- create policy warchess_reports_read on public.warchess_reports
--   for select to anon, authenticated using (true);


-- ============================================================
-- 分析用的两个视图（2026-10-28 补）
--
-- 为什么要有视图：原始表里 sides 是一整块 JSON 数组，直接查它得写
-- jsonb_array_elements 加一堆 ->>，每问一个问题重写一遍，问三次就写错两次。
-- 视图把这层"展开"固化下来，之后分析只写普通 SQL。
--
-- ⚠️ 视图**不要** grant 给 anon：
-- PostgreSQL 的视图默认以创建者权限执行，一旦给 anon 开了 select，
-- 就等于绕开上面"只能写不能读"的设计，整张表又变成人人可拉。
-- 分析请用管理员连接（云服务面板 / migrate 角色）。
-- ============================================================

-- 一场两行：每方一行，带 won / ai_level / 阵容。
create or replace view public.warchess_reports_by_side as
select r.id, r.created_at, r.version, r.seed, r.board_w, r.board_h, r.turns, r.winner, r.expansions,
       r.ai->>'level' as ai_level,
       (r.ai->>'opponent')::boolean as ai_opponent,
       (r.ai->>'ally')::boolean as ai_ally,
       (r.ai->>'commander')::boolean as commander,
       s.value->>'side' as side,
       case when r.winner is null then null
            when r.winner = s.value->>'side' then true
            else false end as won,
       (s.value->>'cities')::int as cities,
       (s.value->>'units')::int as units,
       (s.value->>'buildings')::int as buildings,
       (s.value->>'gold')::int as gold,
       (s.value->>'hp')::int as hp,
       s.value->'eras' as eras,
       s.value->'roster' as roster
from public.warchess_reports r
cross join lateral jsonb_array_elements(r.sides) s;

-- 一个兵种一行：把每方的终局阵容炸开，用来算采用率。
create or replace view public.warchess_reports_units as
select r.id, r.created_at, r.seed, r.turns, r.winner, r.expansions, r.ai->>'level' as ai_level,
       s.value->>'side' as side,
       u.key as unit_id,
       (u.value)::int as count
from public.warchess_reports r
cross join lateral jsonb_array_elements(r.sides) s
cross join lateral jsonb_each(coalesce(s.value->'roster', '{}'::jsonb)) u;

