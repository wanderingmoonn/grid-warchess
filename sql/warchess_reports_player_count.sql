-- 战报表补一列：几个人在打（2 / 3 / 4）
--
-- 为什么单独一列，而不是从 sides 的长度推：
--   · v1 时代的报告 sides 一律两条，混进新数据后没法区分"两人局"和
--     "三人局里有一家城市被吃干净"；
--   · 分组查询要能直接 where player_count = 4，不必每次去数 jsonb 数组。
--
-- 整份报告仍然原样存在 payload 里，这一列只是给人查的（和 seed / turns 一样）。
-- 代码里做了降级（见 src/net/reports.ts）：库还没跑这条 alter 时，
-- 上传会自动省掉这一列再写一次，不会因为"表里少一列"就传不上去。
--
-- 执行位置：云数据库的 SQL 控制台。可重复执行。
-- 老数据这一列会是 null —— 那是 unset，不是 0。

alter table public.warchess_reports add column if not exists player_count smallint;

comment on column public.warchess_reports.player_count is
  '这一局几个席位（2/3/4）。2026-11-01 之前的报告为 null';

-- 检查：列在不在
-- select column_name, data_type from information_schema.columns
--  where table_name = 'warchess_reports' and column_name = 'player_count';
