# 口语特训

旅行英语口语特训工具（spec v1.1 的实现）。一个发布在 claude.ai 上的 Artifact 页面，外加录音分析脚本。

- **页面**：https://claude.ai/artifact/84cSQjgc69s1EM4Epd65Qv （M0 探针和正式页面同一地址，db 和录音跨版本保留）
- **附属文件**（随页面发布，任何会话可用 `Artifact read` + `path` 取回）：`tools/analyze.py`、`tools/speak.py`、`tools/RUNBOOK.md`
- 诊断入口：页面右上角"设置 → 诊断"，或打开 `…/84cSQjgc69s1EM4Epd65Qv#probe`

## 目录

| 路径 | 内容 |
|---|---|
| `src/style.css` | 全部样式（浅色 / 深色 token） |
| `src/js/consts.js` | 错误分类、提示词模板（spec §6、§8）、固定题 —— 集中一处 |
| `src/js/platform.js` | **适配层**：所有 `claude.use()` 都在这里，对外只有 `store` / `blobs` / `llm`（spec §14） |
| `src/js/util.js` | DOM 小工具、localStorage、朗读（speechSynthesis）、事件总线 |
| `src/js/audio.js` | 解码、本地粗测停顿（spec §9）、上传类型映射与 base64 包装 |
| `src/js/probe.js` | M0 探针 9 项 + 决策表 |
| `src/js/data.js` | db 订阅、派生统计、练习场次（sessions） |
| `src/js/practice.js` | 节点列表、听懂、逐句反馈、实战对话与讲评、盖章生成口袋本 |
| `src/js/record.js` | 录音（页面录 / 系统录音机 / 选文件）、上传、录音列表与分析结果展示 |
| `src/js/dash.js` | 看板 |
| `src/js/pocket.js` | 口袋本、导出离线 HTML |
| `src/js/settings.js` | 我的素材、偏好、导出全部数据、诊断、关于 |
| `src/app.html` / `src/probe.html` | 页面骨架 |
| `dist/kouyu.html` | 构建产物，也就是发布的页面 |
| `seed/seed.json` | 种子数据（附录 A）：16 个节点、7 个角色、`config/app`、`config/profileDraft` |
| `tools/analyze.py` | 录音分析脚本（附录 B，已在 Claude Code 云端容器里跑通） |
| `tools/speak.py` | 真人感发音：用 Kokoro v1.0 生成音轨，写 `audio/<sprite>` 索引 |
| `tools/RUNBOOK.md` | 录音分析流程（spec §10）和生成发音流程 |

## 构建与发布

```bash
python3 build.py            # → dist/kouyu.html（完整页面）
python3 build.py probe      # → dist/kouyu.html（只有 M0 探针）
node --check dist/kouyu.js  # 语法检查
```

发布（在有 Artifact 工具的会话里）：`Artifact publish`，`file_path: dist/kouyu.html`，`url` 填上面的地址，`files` 带上
`tools/analyze.py`、`tools/speak.py`（`contentType: text/plain`）和 `tools/RUNBOOK.md`（`text/markdown`）。capabilities 已存为
`{db, assets, sample, downloads}`，重新发布时省略即可沿用。

种子数据用 ArtifactData `batch` 写入（每个文档一个 `set`）。已经写过一次；再写会覆盖节点的 `status`。

## 与 spec 的差异和补充

- runtime contract 是 **0.2.58**（spec 写的是 0.2.57），按 0.2.58 的类型定义实现。
- 平台文档说明 artifact 查看器的 iframe **拒绝麦克风**（不弹框）。页面在运行时自动选择录音方式：先试页面录音，失败就记住并切到"系统录音机 / 选文件"（备选 A）。M0 探针的结果也会写进本机，用于同样的选择和"说一次就够"的开关。
- drill 提示词第 6 条加了 `{{role}}`：社交节点是旅伴，办事节点是工作人员。办事节点不显示"反问"提醒；看板的反问率只统计社交节点。
- 实战对话每轮用 `quick` 档（spec 未指定）；讲评用 `default`，小结用 `quick`。
- `me/profile` 只在用户在设置里确认后才写入；预填草稿放在 `config/profileDraft`。
- `config/app` 另有 `tripStart` / `tripEnd`（顶栏倒计时）。角色多了 `bio_zh`、`setting_zh`、`native`、`fluent`、`order`；售票员叫 Paolo。C3 的听力条目带 `tts: false`。
- `recordings` 另有 `sizeBytes`、`fileName`、`audioDeletedAt`、`error`；`sessions.summary` 另有 `nTurns`、`nWords`。
- `analyze.py` 多读一个环境变量 `FFMPEG`（容器里没有 ffmpeg 时用 imageio-ffmpeg 的二进制）。
- 每个 artifact 的 db 上限 5000 个文档。每条回答一个 `turns` 文档，按每天 30 条算到 11 月也不到 2000，够用。

## v1.1 改动（2026-09-26，按试用反馈）

- **语音输入不准**：提示词加了 `ASR_NOTE`，先还原输入法听错的词（Camino → communal、walking → working 等），
  输出 `understood`；听错不再算成学习者的错误。反馈卡在原话和理解不一样时显示"理解为"。
- **对方只会追问**：逐句反馈里"对方"现在是一位具体的旅伴（`DRILL_PARTNERS`，每个节点记住一位，可"换个旅伴"），
  会先回答学习者的反问、分享自己的经历、不重复问过的问题，不是每轮都提问。实战对话的提示词同样调整。
- **提示单一**：去掉固定的"没有反问，加 What about you"，改为 Claude 按需给的 `tip_zh`（不重复）和贴合当下的 `ask_back_en`。
- **真人感发音**：Claude 会话用 Kokoro 生成音频（`tools/speak.py`），存为资产 + `audio/*` 索引；页面实心播放按钮播它，
  可放慢且不变调；没有时退回手机朗读。`turns` 新增字段 `understood`、`tip_zh`、`ask_back_en`、`partner`。
