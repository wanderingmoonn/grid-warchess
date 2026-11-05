"""训练入口：读一轮采样 → PPO 更新 → 写新权重。

一轮的边界是**采样文件**：TS 那边跑完游戏落一个 `<base>.bin/.json`，
这里读进来更新几轮，导出一份新权重，然后 TS 用新权重再采样。
PPO 本来就是 on-policy 的"采样-更新"交替，所以这个切分不改变语义。

用法（项目根目录）：
    .venv/Scripts/python.exe scripts/rl/py/train.py \\
        --data .tmp/rollout-0 --weights scripts/rl/weights/init.json \\
        --out .tmp/weights/iter-1.json --epochs 4

自检：输出里的 `ratio 偏差` 如果是 0（< 1e-6），说明 Python 的前向和采样时的 TS 前向
逐位一致——这是"这份 batch 真的属于当前策略"的证明，也是 PPO 成立的前提。
"""

from __future__ import annotations

import argparse
import json
import os

import net
import ppo


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, help="采样文件的基名（不带 .bin/.json）")
    ap.add_argument("--weights", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--epochs", type=int, default=4)
    ap.add_argument("--lr", type=float, default=3e-4)
    ap.add_argument("--batch", type=int, default=2048)
    ap.add_argument("--clip", type=float, default=0.2)
    ap.add_argument("--vf-coef", type=float, default=0.5)
    ap.add_argument("--ent-coef", type=float, default=0.01)
    args = ap.parse_args()

    w = net.load(args.weights)
    roll = ppo.load_rollout(args.data)
    steps = len(roll)
    games = int(len(set(roll.game.tolist())))
    rewards = roll.reward[roll.reward != 0]
    drop = roll.manifest.get("droppedGames", 0)
    note = f"（已按'没打完'丢掉 {drop} 局 / {roll.manifest.get('droppedSteps', 0)} 步）" if drop else ""
    print(f"采样：{steps} 步 / {games} 局 · 终局奖励 {rewards.tolist()}{note}")

    model = ppo.TorchPolicy(w)
    cfg = ppo.PpoConfig(
        lr=args.lr, clip=args.clip, epochs=args.epochs, batch=args.batch,
        vf_coef=args.vf_coef, ent_coef=args.ent_coef,
    )
    # 先按采样时刻的优势算一份，用来做分桶诊断（update 内部会再算一遍，这里要的是"更新前"的口径）
    adv_for_diag, _ = ppo.compute_gae(roll, cfg.gamma, cfg.lam)
    adv_for_diag = (adv_for_diag - adv_for_diag.mean()) / (adv_for_diag.std() + 1e-8)
    stats = ppo.update(model, roll, cfg)

    dev = stats.pop("ratio_dev_max", float("nan"))
    print(f"前向一致性：ratio 与 1 的最大偏差 {dev:.2e}（应 < 1e-6，否则两侧前向不一致）")
    print(
        "更新："
        + " · ".join(
            f"{k} {v:.4f}" if abs(v) >= 1e-3 else f"{k} {v:.2e}" for k, v in sorted(stats.items())
        )
    )

    ppo.print_diagnosis(ppo.diagnose(model, roll, adv_for_diag, roll.logp))

    out = model.to_weights(w)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    net.save(args.out, out)
    with open(args.out.replace(".json", ".meta.json"), "w", encoding="utf-8") as fh:
        json.dump({"data": args.data, "steps": steps, "games": games, "stats": stats}, fh, indent=2)
    print(f"权重 → {args.out}")
    return 0 if dev < 1e-6 else 1


if __name__ == "__main__":
    raise SystemExit(main())
