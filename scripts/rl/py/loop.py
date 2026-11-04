"""一轮一轮跑：采样 → 更新 → 评估 → 换权重再来。

── 为什么用 Python 当编排器 ────────────────────────────────────────────

采样必须留在 TS（引擎在那儿），训练只能在 Python。总得有一边负责"叫另一边干活"，
而这一侧的循环体就是三次 subprocess：`node rollout.ts` → `train.py` → `node eval.ts`。
写成 shell 也行，但那样统计量、断点续跑、曲线全得靠 awk——不如直接用 Python。

── 每一轮看什么 ────────────────────────────────────────────────────────

  win%    对**手写 AI** 的配对胜率（唯一有意义的指标；自博弈胜率永远是 50%）
  logp    采样时策略对自己所选动作的平均对数概率（它该随训练缓慢下降 = 越来越自信）
  kl      更新前后的近似 KL（PPO 的健康带：1e-4 ~ 1e-2，太大说明 lr 或 clip 不对）
  ent     策略熵（掉到 0 附近就是提前收敛，通常意味着探索没了）

用法：
    .venv/Scripts/python.exe scripts/rl/py/loop.py --iters 3 --games 24 --eval-games 40
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
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stdout[-4000:])
        sys.stderr.write(proc.stderr[-4000:])
        raise SystemExit(f"命令失败（{proc.returncode}）：{' '.join(cmd)}")
    return proc.stdout


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--iters", type=int, default=3)
    ap.add_argument("--games", type=int, default=24, help="每轮采样几局")
    ap.add_argument("--eval-games", type=int, default=40, help="每轮评估几局（0 = 不评估）")
    ap.add_argument("--seed0", type=int, default=8100, help="采样种子的起点，每轮往后挪，避免背题")
    ap.add_argument("--weights", default="scripts/rl/weights/init.json")
    ap.add_argument("--work", default=".tmp/m2")
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=3e-4)
    args = ap.parse_args()

    os.makedirs(args.work, exist_ok=True)
    weights = args.weights
    log_path = os.path.join(args.work, "log.jsonl")
    open(log_path, "w", encoding="utf-8").close()

    print(f"{'轮':>3} {'步数':>6} {'胜率':>7} {'logp':>8} {'KL':>9} {'熵':>7} {'用时':>6}")
    for it in range(args.iters):
        t0 = time.time()
        data = os.path.join(args.work, f"rollout-{it}")
        # 每轮换一批种子：同一批种子反复训练，模型会把这一批的地图背下来
        run([
            "node", "--experimental-strip-types", "scripts/rl/rollout.ts",
            "--games", str(args.games), "--seed0", str(args.seed0 + it * 1000),
            "--weights", weights, "--out", data,
        ])
        nxt = os.path.join(args.work, f"weights-{it + 1}.json")
        out = run([PY, os.path.join("scripts", "rl", "py", "train.py"),
                   "--data", data, "--weights", weights, "--out", nxt,
                   "--epochs", str(args.epochs), "--lr", str(args.lr)])

        roll = json.load(open(f"{data}.json", encoding="utf-8"))
        stats: dict[str, float] = {}
        for line in out.splitlines():
            if line.startswith("更新："):
                for part in line[3:].split(" · "):
                    k, _, v = part.partition(" ")
                    try:
                        stats[k] = float(v)
                    except ValueError:
                        pass
        with open(f"{data}.bin", "rb") as fh:
            import numpy as np

            flat = np.fromfile(fh, dtype="<f4").reshape(-1, roll["width"])
        mean_logp = float(flat[:, roll["state"] + roll["k"] * roll["action"] + 0].mean())

        win = float("nan")
        if args.eval_games > 0:
            ev = run([
                "node", "--experimental-strip-types", "scripts/rl/eval.ts",
                "--mode", "policy", "--weights", nxt, "--games", str(args.eval_games),
                "--seed0", "90000",
            ])
            for line in ev.splitlines():
                if "得分率" in line:
                    win = float(line.split("得分率")[1].split("%")[0])

        row = {
            "iter": it + 1,
            "steps": roll["steps"],
            "win": win,
            "mean_logp": mean_logp,
            "kl": stats.get("approx_kl", float("nan")),
            "entropy": stats.get("entropy", float("nan")),
            "ratio_dev": stats.get("ratio_dev_max", float("nan")),
            "secs": round(time.time() - t0, 1),
            "weights": nxt,
        }
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(
            f"{row['iter']:>3} {row['steps']:>6} {win:>6.1f}% {mean_logp:>8.3f} "
            f"{row['kl']:>9.2e} {row['entropy']:>7.3f} {row['secs']:>5.0f}s"
        )
        weights = nxt

    best = os.path.join(args.work, "latest.json")
    shutil.copyfile(weights, best)
    print(f"\n最后一轮权重 → {weights}（另存 {best}）；明细 {log_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
