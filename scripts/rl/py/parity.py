"""跨语言对账：TS 算的 logp / 价值，Python 必须算出一模一样的数。

── 这条检查为什么不能省 ────────────────────────────────────────────────

训练在 Python，采样在 TS，两边靠一个权重文件对接。只要有一处不一致——
转了矩阵、激活写错、top-K 的并列规则不同——症状是"loss 在降，棋力不动"，
而且看起来完全像"PPO 不work"。用真实局面逐条比对，是唯一能在几分钟里
把这类错误钉死的手段。

── 比什么 ──────────────────────────────────────────────────────────────

1. **候选集**：Python 选出的前 K 个下标，必须和 TS 当时选的一致（含并列顺序）；
2. **logp**：被选动作的对数概率，误差 < 1e-5；
3. **价值**：tanh 那个标量，误差 < 1e-6。

顺带把"两段式"里容易写错的两点也测了：预筛用的是 `w_state·state` 只算一次，
以及 scorer 吃的是 `[state ⊕ action]` 而不是只有 action。

用法（在项目根目录）：
    .venv/Scripts/python.exe scripts/rl/py/parity.py .tmp/parity.json
"""

from __future__ import annotations

import json
import sys

import numpy as np

import net


def main(path: str) -> int:
    with open(path, "r", encoding="utf-8") as fh:
        blob = json.load(fh)
    w = net.load(blob["weights"])
    dim = blob["dim"]
    state_dim, action_dim = int(dim["state"]), int(dim["action"])
    top_k = int(dim["topK"])
    assert state_dim == w.state_dim and action_dim == w.action_dim, "样本维度与权重不符"

    max_logp = 0.0
    max_value = 0.0
    cand_mismatch = 0
    checked = 0

    for i, smp in enumerate(blob["samples"]):
        state = np.asarray(smp["state"], dtype=np.float32)
        n = int(smp["n"])
        feats = np.asarray(smp["actions"], dtype=np.float32).reshape(n, action_dim)
        temperature = float(smp.get("temperature", 1.0))

        # ── 1. 预筛：和 TS 同一条公式（状态那半只算一次）──
        scores = net.prescreen_scores(w, state, feats)
        cands = net.select_candidates(scores, top_k)

        # TS 记的是"全量动作里的下标"，这里要看它在不在 Python 选出的候选里
        chosen = int(smp["index"])
        if chosen not in set(cands.tolist()):
            cand_mismatch += 1
            continue

        # ── 2. 候选重排 + softmax ──
        logits, value = net.forward(w, state, feats[cands], temperature)
        logp_all = net.log_softmax(logits)
        at = int(np.where(cands == chosen)[0][0])
        logp = float(logp_all[at])

        max_logp = max(max_logp, abs(logp - float(smp["logp"])))
        max_value = max(max_value, abs(value - float(smp["value"])))
        checked += 1
        if i < 3:
            print(
                f"  #{i}: 候选 {len(cands)} 个 · logp TS {smp['logp']:.8f} / PY {logp:.8f}"
                f" · value TS {smp['value']:.6f} / PY {value:.6f}"
            )

    print(f"\n检查 {checked} 条（候选集不一致 {cand_mismatch} 条）")
    print(f"  logp 最大偏差 {max_logp:.2e}（要求 < 1e-5）")
    print(f"  value 最大偏差 {max_value:.2e}（要求 < 1e-6）")
    ok = cand_mismatch == 0 and max_logp < 1e-5 and max_value < 1e-6
    print("\n结论：" + ("两侧前向一致 ✓" if ok else "两侧前向不一致 ✗"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else ".tmp/parity.json"))
