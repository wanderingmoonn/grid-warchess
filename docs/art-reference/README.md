# 地形材质的"真图"在哪里

**结论先说：材质模式下真正渲染的图，绝大部分不在 `public/art/terrain/` 里，
而是 base64 内联在 `src/style.css` 里。**

上一轮做台地材质时踩了这个坑：拿 `public/art/terrain/hill.webp` 当丘陵参考，
照着它调色、照着它做图生图——**但那张图没有任何规则引用它**，
游戏里真正的丘陵是 CSS 里内联的一张 330×330 PNG，两者明度差 30 级、质感也不同。

## 现状（2026-11-13 清理后）

| 地形 | 真图在哪 | 尺寸 |
|---|---|---|
| 丘陵 | `src/style.css` 内联，已导出为 `hill.png` | 330×330 |
| 平原 | 内联，`plain.png` | 56×56 |
| 森林 | 内联两张，`forest.png` / `forest-2.png` | 128×128 |
| 台地 | 内联，`plateau.png` | 512×512 |
| 高山 | **走文件引用**：`url('/art/terrain/mountain.webp')` | 512×512 源 |
| 浅水 / 深水 | 不是贴图，是 CSS 渐变 + 动画 | — |

`public/art/terrain/` 下其余文件（hill.webp、plain-*.png、forest.webp、water.webp、deep.webp…）
**都已删除**——它们没有任何引用，留着只会让下一个人再抓错。

## 为什么内联

见 `style.css` 森林那一段的注释：托管环境对不带 sharecode 的静态请求会 403，
所以那批图当年改成了 base64 内联。

## 要改材质时

1. 先从 CSS 里把当前图导出来（就是本目录这几张，或者按下面的命令重新导）：
   `python .tmp/extract-inline-art.py`
2. 以**导出的图**为准做参考/生成，不要用 `public/` 里的历史文件；
3. 改完记得同步回 CSS 的 base64（台地那一段有现成的 `re.sub` 写法可抄）。
