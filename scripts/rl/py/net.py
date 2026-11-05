"""策略网络的 Python 侧：权重读写 + 与 TS 逐位对齐的前向。

── 为什么要"逐位对齐"而不是"差不多就行" ─────────────────────────────────

训练在 Python，推理在 TS（引擎在那儿）。两边跑的是同一套权重，只要有一处
对不上——激活函数写错、矩阵转置反了、top-K 的选择规则不同——就会出现
"训练时 loss 在降、上线后棋力不动"这种最难查的状态。

所以这里的第一条纪律是：**Python 的前向必须给出和 TS 一模一样的 logp**。
`parity.py` 就是拿 TS 导出的真实样本逐条比对的，误差要求 1e-5 以内。

── 两段式推理里，哪一段是可训练的 ────────────────────────────────────────

TS 的策略是两段：线性预筛（204 维点积）挑出前 16 个动作，再让一个小 MLP
在这 16 个里重排并 softmax。**预筛那段不参与训练**：它不进 softmax，没有梯度，
而且一旦它跟着变，"当时采样用的候选集"就和"现在算 ratio 用的候选集"不是同一批，
PPO 的 importance ratio 会失去意义。

所以 M2 v1 的口径是：预筛冻结（只当特征筛选器），训练 scorer + value 这 22,786 个参数。
要训预筛得另做一套（每轮重算候选集 + 用旧候选集近似），那是 M3 的事。
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any

import numpy as np

# v2：观测加进"环境描述(27) + 意图(4) + 棋盘高度面(36)"，动作类型 one-hot 7 → 13。
# 版本号必须跟着涨：v1 的权重形状对不上，硬读会得到一串静默错位的数。
WEIGHTS_VERSION = 2
DEFAULT_SPEC = {"state": 221, "action": 62, "joint": 283, "hidden": 64, "topK": 16}


# ── 权重文件的读写 ──────────────────────────────────────────────────────


def _b64_to_f32(text: str) -> np.ndarray:
    """base64 → float32。TS 侧写的是 Float32Array 的原始字节（小端）。"""
    return np.frombuffer(base64.b64decode(text), dtype="<f4").astype(np.float32)


def _f32_to_b64(arr: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(arr, dtype="<f4").tobytes()).decode()


@dataclass
class Weights:
    """和 TS 的 `Weights` 一一对应。

    字段名刻意保持一样的层级（prescreen / scorer / value），
    这样两边 diff 一个权重文件时，肉眼看形状就能对上。
    """

    version: int
    spec: dict[str, int]
    pre_w: np.ndarray  # [joint]
    pre_b: float
    s_w1: np.ndarray  # [hidden, joint]
    s_b1: np.ndarray  # [hidden]
    s_w2: np.ndarray  # [hidden]
    s_b2: float
    v_w1: np.ndarray  # [hidden, state]
    v_b1: np.ndarray  # [hidden]
    v_w2: np.ndarray  # [hidden]
    v_b2: float

    @property
    def state_dim(self) -> int:
        return int(self.spec["state"])

    @property
    def action_dim(self) -> int:
        return int(self.spec["action"])

    @property
    def hidden(self) -> int:
        return int(self.spec["hidden"])


def load(path: str) -> Weights:
    with open(path, "r", encoding="utf-8") as fh:
        raw: dict[str, Any] = json.load(fh)
    if raw.get("version") != WEIGHTS_VERSION:
        raise ValueError(f"权重版本不对：{raw.get('version')}，本代码只认 {WEIGHTS_VERSION}")
    spec = raw["spec"]
    hidden = int(spec["hidden"])
    joint = int(spec["joint"])
    state = int(spec["state"])
    if joint != state + int(spec["action"]):
        raise ValueError("权重里的维度自相矛盾")
    return Weights(
        version=int(raw["version"]),
        spec={"state": state, "action": int(spec["action"]), "joint": joint, "hidden": hidden, "topK": int(spec["topK"])},
        pre_w=_b64_to_f32(raw["prescreen"]["w"]),
        pre_b=float(raw["prescreen"]["b"]),
        s_w1=_b64_to_f32(raw["scorer"]["w1"]).reshape(hidden, joint),
        s_b1=_b64_to_f32(raw["scorer"]["b1"]),
        s_w2=_b64_to_f32(raw["scorer"]["w2"]),
        s_b2=float(raw["scorer"]["b2"]),
        v_w1=_b64_to_f32(raw["value"]["w1"]).reshape(hidden, state),
        v_b1=_b64_to_f32(raw["value"]["b1"]),
        v_w2=_b64_to_f32(raw["value"]["w2"]),
        v_b2=float(raw["value"]["b2"]),
    )


def save(path: str, w: Weights) -> None:
    """写回 TS 能直接读的格式（同一份 base64 float32，不经过十进制）。"""
    payload = {
        "version": w.version,
        "spec": w.spec,
        "prescreen": {"w": _f32_to_b64(w.pre_w), "b": w.pre_b},
        "scorer": {
            "w1": _f32_to_b64(w.s_w1.reshape(-1)),
            "b1": _f32_to_b64(w.s_b1),
            "w2": _f32_to_b64(w.s_w2),
            "b2": w.s_b2,
        },
        "value": {
            "w1": _f32_to_b64(w.v_w1.reshape(-1)),
            "b1": _f32_to_b64(w.v_b1),
            "w2": _f32_to_b64(w.v_w2),
            "b2": w.v_b2,
        },
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)


# ── 前向（与 TS 的 Policy 逐步对应）──────────────────────────────────────


def prescreen_scores(w: Weights, state: np.ndarray, actions: np.ndarray) -> np.ndarray:
    """线性预筛的分数。

    和 TS 一样利用了 `w·[state ⊕ action] = w_state·state + w_action·action`：
    前半截与动作无关，只算一次，候选再多也只是几百次点积。
    """
    sw = w.pre_w[: w.state_dim]
    aw = w.pre_w[w.state_dim :]
    return actions @ aw + (float(sw @ state) + w.pre_b)


def select_candidates(scores: np.ndarray, top_k: int) -> np.ndarray:
    """按分数降序取前 top_k 个下标。

    必须和 TS 的"部分选择"同序：TS 用"严格大于"找最大，所以**并列时下标小的在前**。
    `np.argsort(-scores, kind='stable')` 正好是这条规则；换成默认的 quicksort
    在分数打平时顺序不定，ratio 就会莫名其妙地抖。
    """
    k = min(top_k, scores.shape[0])
    return np.argsort(-scores, kind="stable")[:k]


def forward(
    w: Weights,
    state: np.ndarray,
    cands: np.ndarray,
    temperature: float = 1.0,
) -> tuple[np.ndarray, float]:
    """对**候选动作**跑 scorer，返回 (logits, value)。

    入参 `cands` 是已经挑好的候选动作特征 [K, action]（也接受单个动作的 [action]）。
    和 TS 一样：scorer 吃的是 `[state ⊕ action]`，value 只吃 state。
    """
    cands = np.atleast_2d(np.asarray(cands, dtype=np.float32))
    k = cands.shape[0]
    state = np.asarray(state, dtype=np.float32)
    x = np.concatenate([np.broadcast_to(state, (k, state.shape[0])), cands], axis=1)  # [K, joint]
    h = np.maximum(x @ w.s_w1.T + w.s_b1, 0.0)
    logits = h @ w.s_w2 + w.s_b2
    hv = np.maximum(state @ w.v_w1.T + w.v_b1, 0.0)
    value = float(np.tanh(hv @ w.v_w2 + w.v_b2))
    return (logits / max(temperature, 1e-3)).astype(np.float32), value


def log_softmax(logits: np.ndarray) -> np.ndarray:
    m = float(np.max(logits))
    z = logits - m
    return z - float(np.log(np.exp(z).sum()))
