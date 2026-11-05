"""一轮一轮跑：采样 → 更新 → 评估 → 换权重再来。

── 为什么用 Python 当编排器 ────────────────────────────────────────────

采样必须留在 TS（引擎在那儿），训练只能在 Python。总得有一边负责"叫另一边干活"，
而这一侧的循环体就是三次 subprocess：`node rollout.ts` → `train.py` → `node eval.ts`。
写成 shell 也行，但那样统计量、断点续跑、曲线全得靠 awk——不如直接用 Python。

── 每一轮看什么 ────────────────────────────────────────────────────────

  win@档  在当前难度档上对**手写 AI** 的配对得分率（课程学习的升降信号）
  win@高  在最高档（advanced）上的得分率（唯一和"M2 判据"对齐的数字）
  logp    采样时策略对自己所选动作的平均对数概率（它该随训练缓慢下降 = 越来越自信）
  kl      更新前后的近似 KL（PPO 的健康带：1e-4 ~ 1e-2，太大说明 lr 或 clip 不对）
  ent     策略熵（掉到 0 附近就是提前收敛，通常意味着探索没了）

── 为什么要课程学习（2026-11-05 加）──────────────────────────────────

直接在高级档上跑，采样是 **160:0**：每局都输，每一步的终局奖励都是 −1。
优势里于是没有"这一步比那一步好"的对比，只剩价值头的拟合残差在冒充信号——
KL 看着很健康（1e-3）、logp 在慢慢变、熵在慢慢掉，胜率一动不动（六轮 0.0%）。
这不是 PPO 不行，是**没有可学的对比**。所以先降到初级档（不做 lookahead、不辨兵种），
赢到六成再抬一档，抬不上去就在这一档多练。

用法：
    .venv/Scripts/python.exe scripts/rl/py/loop.py --iters 8 --games 160 --eval-games 60
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
PY = sys.executable


def run(cmd: list[str], cwd: str = ROOT) -> str:
    proc = subprocess.run(
        cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace"
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-4000:])
        sys.stderr.write(proc.stderr[-4000:])
        raise SystemExit(f"命令失败（{proc.returncode}）：{' '.join(cmd)}")
    return proc.stdout


def score_of(out: str) -> float:
    """从 eval.ts 的输出里抠出"得分率"（胜 1 分、平 0.5 分，所以它不是胜率）"""
    for line in out.splitlines():
        if "得分率" in line:
            return float(line.split("得分率")[1].split("%")[0])
    return float("nan")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=3)
    ap.add_argument("--games", type=int, default=24, help="每轮采样几局")
    ap.add_argument("--eval-games", type=int, default=40, help="每轮评估几局（0 = 不评估）")
    ap.add_argument("--seed0", type=int, default=8100, help="采样种子的起点，每轮往后挪，避免背题")
    ap.add_argument("--eval-seed0", type=int, default=90000, help="评估种子固定，各轮才可比")
    ap.add_argument("--weights", default="scripts/rl/weights/init.json")
    ap.add_argument("--work", default=".tmp/m2")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument(
        "--opponent", default="pool", choices=["ai", "pool"],
        help="ai=只打手写 AI；pool=自博弈/打 AI/打快照",
    )
    ap.add_argument("--ai-level", default="advanced", help="手写 AI 的难度档（basic/tactic/advanced）")
    ap.add_argument(
        "--levels", default="0.9,0.7,0.5,0.3,0.15,0",
        help="课程阶梯：从强削弱到不削弱，写的是 ai-handicap 的取值。只写一个就是固定。",
    )
    ap.add_argument("--advance-win", type=float, default=60.0, help="当前档得分率到这个数就抬一档")
    ap.add_argument(
        "--self-max", type=float, default=0.6,
        help="自博弈占比的上限。实际占比按上一轮胜率爬坡：<5%% 不给，25%% 给满",
    )
    args = ap.parse_args()

    levels = [x.strip() for x in args.levels.split(",") if x.strip()]
    if not levels:
        raise SystemExit("--levels 不能为空")
    target = levels[-1]  # 阶梯的最后一级 = 目标口径（默认 0 = 不削弱）

    os.makedirs(args.work, exist_ok=True)
    snap_dir = os.path.join(args.work, "snapshots")
    os.makedirs(snap_dir, exist_ok=True)
    weights = args.weights
    log_path = os.path.join(args.work, "log.jsonl")
    open(log_path, "w", encoding="utf-8").close()

    print(
        f"{'轮':>3} {'削弱':>5} {'步数':>6} {'采样胜':>7} {'win@档':>7} {'win@0':>7} "
        f"{'logp':>8} {'KL':>9} {'熵':>7} {'用时':>6}"
    )
    self_share = 0.0  # 第一轮：一次自博弈都不安排（见 rollout.ts 里那段说明）
    level_i = 0
    for it in range(args.iters):
        t0 = time.time()
        level = levels[level_i]
        data = os.path.join(args.work, f"rollout-{it}")
        # 每轮换一批种子：同一批种子反复训练，模型会把这一批的地图背下来
        run([
            "node", "--experimental-strip-types", "scripts/rl/rollout.ts",
            "--games", str(args.games), "--seed0", str(args.seed0 + it * 1000),
            "--weights", weights, "--out", data,
            "--opponent", args.opponent, "--snapshots", snap_dir,
            "--self-share", f"{self_share:.2f}", "--ai-level", args.ai_level,
            "--ai-handicap", level,
        ])
        roll = json.load(open(f"{data}.json", encoding="utf-8"))

        nxt = os.path.join(args.work, f"weights-{it + 1}.json")
        out = run([PY, os.path.join("scripts", "rl", "py", "train.py"),
                   "--data", data, "--weights", weights, "--out", nxt,
                   "--epochs", str(args.epochs), "--lr", str(args.lr)])
        # 把 train.py 的诊断原样转出来：分桶表现在是唯一能看出"到底哪类局面在动"的东西，
        # 只留在被 run() 吞掉的 stdout 里等于没有
        for line in out.splitlines():
            if line.startswith(("回合", "动作", "席位", "分桶诊断", "采样：", "  ←")) or "  ←" in line:
                print("    " + line.rstrip())

        stats: dict[str, float] = {}
        for line in out.splitlines():
            if line.startswith("更新："):
                for part in line[3:].split(" · "):
                    k, _, v = part.partition(" ")
                    try:
                        stats[k] = float(v)
                    except ValueError:
                        pass

        import numpy as np

        with open(f"{data}.bin", "rb") as fh:
            flat = np.fromfile(fh, dtype="<f4").reshape(-1, roll["width"])
        mean_logp = float(flat[:, roll["state"] + roll["k"] * roll["action"] + 0].mean())

        # 采样这边的胜率是白送的课程信号：这一轮打的就是 level 这一档，不用额外评估
        played = roll.get("perGame", [])
        sample_win = 100.0 * sum(1 for g in played if g.get("winner") == "A") / max(1, len(played))

        win_cur = float("nan")
        win_tgt = float("nan")
        if args.eval_games > 0:
            ev = run([
                "node", "--experimental-strip-types", "scripts/rl/eval.ts",
                "--mode", "policy", "--weights", nxt, "--games", str(args.eval_games),
                "--seed0", str(args.eval_seed0), "--ai-level", args.ai_level,
                "--ai-handicap", level,
            ])
            win_cur = score_of(ev)
            if level == target:
                win_tgt = win_cur
            else:
                # 目标档永远是"不削弱"：课程只是通往它的路，不能拿削弱档的成绩当进步
                ev2 = run([
                    "node", "--experimental-strip-types", "scripts/rl/eval.ts",
                    "--mode", "policy", "--weights", nxt, "--games", str(args.eval_games),
                    "--seed0", str(args.eval_seed0), "--ai-level", args.ai_level,
                    "--ai-handicap", target,
                ])
                win_tgt = score_of(ev2)

        row = {
            "iter": it + 1,
            "level": level,
            "self_share": round(self_share, 2),
            # 这一轮实际抽到了哪几种对手：配比是概率，实际局数才是事实
            "modes": roll.get("modeCounts", {}),
            "steps": roll["steps"],
            "sample_win": sample_win,
            "win_cur": win_cur,
            "win_target": win_tgt,
            "mean_logp": mean_logp,
            "kl": stats.get("approx_kl", float("nan")),
            "entropy": stats.get("entropy", float("nan")),
            "ratio_dev": stats.get("ratio_dev_max", float("nan")),
            "secs": round(time.time() - t0, 1),
            "weights": nxt,
        }
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False, default=float) + "\n")
        print(
            f"{row['iter']:>3} {level:>9} {row['steps']:>6} {sample_win:>6.1f}% {win_cur:>6.1f}% "
            f"{win_tgt:>6.1f}% {mean_logp:>8.3f} {row['kl']:>9.2e} {row['entropy']:>7.3f} {row['secs']:>5.0f}s"
        )

        # 课程升降：够格才抬档，抬一档就清零重练。不往回退——
        # 同一档位来回横跳会让"这一轮的成绩"失去可比性，而退档的收益只是省点时间。
        if level_i + 1 < len(levels) and win_cur == win_cur and win_cur >= args.advance_win:
            level_i += 1
            print(
                f"    ↳ 升档：削弱 {level} → {levels[level_i]}"
                f"（得分率 {win_cur:.1f}% ≥ {args.advance_win:.0f}%）"
            )
        # 自博弈的准入线：得分率不到 5% 说明还不会打架，两个自己互相下只会全平局（没有信号）；
        # 到 25% 说明已经能互相打死，自博弈可以占满配额。线性爬坡，避免突然切换。
        #
        # **必须用 win_tgt（不削弱那一档）而不是 win_cur**：课程期的 win_cur 是"削弱之后的 AI"，
        # 那个数再高也不代表策略会打架。踩过这个坑——削弱 0.9 时 win_cur 90.6%，
        # 准入线当场拉满到 60%，于是 13 局自博弈全部 2500 步以上、撞上限、白烧 866MB。
        if args.opponent == "pool" and win_tgt == win_tgt:  # nan 检查
            self_share = max(0.0, min(args.self_max, (win_tgt - 5.0) / 20.0 * args.self_max))
        # 把这一轮的权重冻成快照给下一轮的对手池用；只留最近三份，
        # 免得二十轮之后"随机挑一个快照"其实在挑二十轮前的古董
        shutil.copyfile(nxt, os.path.join(snap_dir, f"iter-{it + 1}.json"))
        olds = sorted(f for f in os.listdir(snap_dir) if f.startswith("iter-"))
        for f in olds[:-3]:
            os.remove(os.path.join(snap_dir, f))
        weights = nxt

    best = os.path.join(args.work, "latest.json")
    shutil.copyfile(weights, best)
    print(f"\n最后一轮权重 → {weights}（另存 {best}）；明细 {log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
