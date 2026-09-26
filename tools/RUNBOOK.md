# 口语特训 · 录音分析 Runbook

在 Claude 会话中执行（Cowork 或 Claude Code 云端会话都可以）。本文件随页面发布在 artifact 的 `tools/RUNBOOK.md`，脚本在 `tools/analyze.py`（录音分析）和 `tools/speak.py`（真人感发音）。

- Artifact：https://claude.ai/artifact/84cSQjgc69s1EM4Epd65Qv
- 数据库集合：`recordings`（录音）、`audio`（发音索引）、`config/app`（阈值、地址、可选的 `voices`）、`probe`（M0 诊断结果）

**触发条件**：用户说"分析"或"生成发音"，或者发来页面上复制的那句话：`请处理口语特训的新内容（分析录音、生成发音）：<artifact 地址>`（旧版是`请分析口语特训的新录音：…`）。

收到这句话就把两件事都做：第 1–6 步分析待分析的录音，然后做文末"生成发音"。没有待分析的录音就只做后者。

---

## 1. 准备环境

容器被回收后要重新做一遍，大约需要 5 分钟。

```bash
pip install --break-system-packages sherpa-onnx==1.13.8 soundfile
# 选一个目录。Cowork 用 /home/claude/speech；Claude Code 云端会话用 $HOME/speech 或 scratchpad 目录
export SPEECH_DIR=${SPEECH_DIR:-/home/claude/speech}
mkdir -p "$SPEECH_DIR" && cd "$SPEECH_DIR"
curl -L --retry 2 -o asr.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2
file asr.tar.bz2   # 必须显示 bzip2；如果是 23 字节的 "upstream request failed"，重新下载
tar xjf asr.tar.bz2 && rm asr.tar.bz2
export ASR_MODEL_DIR="$SPEECH_DIR/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8"
```

- 用 `Artifact read`（`url` = 上面的 artifact 地址，`path: "tools/analyze.py"`）取回脚本，放在同一目录。
- 模型不在 `/home/claude/speech/...` 时，必须设置 `ASR_MODEL_DIR`（见上）。
- 没有 ffmpeg 时（`which ffmpeg` 为空）：`pip install --break-system-packages imageio-ffmpeg`，然后
  `export FFMPEG=$(python3 -c "import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())")`。脚本会读取这个环境变量。

## 2. 找出待分析的录音

- 用 ArtifactData `query` 查询集合 `recordings`，条件 `["status", "==", "pending"]`，按 `createdAt` 升序。
- 如果是重试，再查一次 `["status", "==", "failed"]`，一起处理。
- 每次最多处理 10 条。
- 需要的字段：`assetId`、`uploadType`、`recMime`、`prompt`、`nodeId`、`fixedPrompt`、`turnId`。
- 读 `config/app` 拿阈值（`pauseSec`、`longPauseSec`、`lowConf`），与脚本默认值不同时，以 config 为准解读结果。

## 3. 下载并运行

- 把每条录音的状态设为 `analyzing`（ArtifactData `batch`，每条 `update {status: "analyzing"}`，带上读到的 `if_version`）。
- 用 `Artifact read`（`url` = artifact 地址，`path` = 录音的 `assetId`）下载录音。
  - `uploadType` 是 `video/webm` → 存成 `<id>.webm`；`video/mp4` → `<id>.m4a`。
  - `uploadType` 是 `text/plain`（base64 包装的原始文件）→ 存成 `<id>.txt`，脚本会自动解码。
  - 下载结果文件名是 assetId 加扩展名，必要时重命名成上面的样子。
  - `recMime` 是 `audio/amr` 的录音来自系统录音机（8 kHz 电话音质）：识别对词尾（-s、-ed）更不可靠，解读低置信度词和 PLUR/AGR 时更要标 `asr_suspect`。
- 把所有文件一次性传给脚本，模型只加载一次：

```bash
cd "$SPEECH_DIR" && python3 analyze.py rec1.webm rec2.m4a rec3.txt > out.json
```

脚本对每个文件输出一个 JSON 对象（依次打印）。字段：`text`、`words[{w,s,e,c}]`、`n_words`、`wpm`、`wpm_excl_pauses`、`pauses[{after_index,after,before,sec,after_punct,long}]`、`pause_method`、`pauses_per_min`、`pauses_not_after_punct`、`longest_pause_s`、`mean_length_of_run`、`low_confidence[{index,w,c,s}]`。

## 4. Claude 解读结果

错误分类必须和页面一致：

| 代码 | 名称 | 默认严重度 |
|---|---|---|
| T-PAST | 该用过去时 | high |
| T-PERF | 该用现在完成（进行）时 | high |
| T-FUT | 计划和将来的说法 | high |
| T-OTHER | 其他时态问题 | high |
| BE-V | be 动词多余或缺失 | low |
| AGR | 主谓一致、第三人称单数 | low |
| PLUR | 单复数 | low |
| ART | 冠词 | low |
| PREP | 介词 | low |
| QWO | 疑问句语序 | high |
| PRON | he/she 等代词混用 | high |
| YESNO | 回答否定疑问句时 yes/no 用反 | high |
| WORD | 用词不当或中式直译 | 视情况 |
| STRUCT | 句子不完整或结构混乱 | 视情况 |

- `sev` 只有 `high` 和 `low`：可能造成误解的算 high，听得懂但不对的算 low。
- 标点、大小写和口语省略（gonna、yeah）不算错误。
- **语法**：对 `text` 按上表找错，每条 `{type, orig, fix, sev, asr_suspect, note_zh}`。词尾类错误（PLUR、AGR、-ed）默认 `asr_suspect: true`，除非明显是用户本人说错了。
- **停顿**：结合上下文，逐个判断是 `mid`（句中卡壳）还是 `boundary`（句间停顿），写进 `pause_kinds[{after_index, kind}]`。`after_punct` 只是参考：识别器会在停顿处自动加标点。
- **低置信度词**，逐个判断，写进 `lowconf_notes[{index, kind, target, note_zh}]`：
  - 在语法错误的位置 → `grammar`；
  - 是一个正常的词 → `pronunciation`，并在 `target` 里写出原本想说的词；
  - 乱词或者无意义的词 → `unclear`，结合题目（`prompt`）推断用户原本想说什么，写进 `target`。
  - 语法错误处置信度也会下降（例如 "I am live" 的 live 只有 0.66–0.77），解读时结合语法判断。
- `summary_zh` 写 2 到 4 行：最突出的一个问题，加一个具体的练习方法。

## 5. 写回结果

用 ArtifactData 更新 `recordings/{id}`（`batch`，每条一个 `update`，带 `if_version`）：

```json
{
  "status": "analyzed",
  "analyzedAt": "<ISO 时间>",
  "analysis": {
    "text": "…", "words": [], "n_words": 0, "wpm": 0, "wpm_excl_pauses": 0,
    "pauses": [], "pause_method": "energy", "pauses_per_min": 0, "pauses_not_after_punct": 0,
    "longest_pause_s": 0, "mean_length_of_run": 0, "low_confidence": [],
    "pause_kinds": [], "lowconf_notes": [], "errors": [], "summary_zh": "…"
  }
}
```

- `words` 往下的字段原样来自脚本输出（去掉 `file`、`duration_s` 也可以保留，页面不依赖它们）。
- 出错时写 `status: "failed"`，并附上一行原因 `error: "…"`。
- 单个文档上限 256 KiB。3 分钟录音约 450 个词，`words` 约 22 KB，不会超。

## 6. 在对话里回复

- 最多 3 行：处理了几条，最值得注意的一点，然后提示去页面"录音"栏查看详情。

---

## 附：M0 探针验证（只做一次）

1. ArtifactData `list` 集合 `probe`，读最新几条（`ua` 字段区分手机、平板、App）。
2. 取第 3 项（`upload.id`）或第 4 项（`filePick.uploadId`）的资产 id，用 `Artifact read` 下载，跑一遍 `analyze.py`。
3. 能出结果就说明整条链路可用。按 spec §11 的决策表告诉用户走哪条路线（页面会根据同一套结果自动选择录音方式）。

## 附：备选 B（录音走对话附件）

页面里既不能录音也不能选文件时，用户会把录音直接作为附件发到对话里：

1. 把附件存到 `$SPEECH_DIR`，跑 `analyze.py`。
2. 按第 4 步解读。
3. 用 ArtifactData `set` 新建 `recordings/<r-时间戳>`：`{nodeId: null, prompt: "<用户说的题目或 null>", fixedPrompt: null, turnId: null, assetId: null, uploadType: null, recMime: "<附件类型>", durationSec, local: null, status: "analyzed", analysis, createdAt, analyzedAt}`。页面的录音列表和看板会直接显示。

---

## 生成发音（真人感发音，Kokoro）

页面上实心的播放按钮播放这里生成的音频；没有的句子退回手机自带朗读。页面的横幅会显示"N 句还没有真人发音"。

**原理**：`speak.py` 把多句话拼成一个 mp4（AAC）"音轨"，一次上传一个资产；`audio/<spriteId>` 文档记录
`{assetId, createdAt, items: [{k, t, s, d, v, r}]}`（key、原文、起点秒、时长秒、声音、角色）。key 是规范化文本的
FNV-1a 32 位哈希，页面 `audioKey()` 用同一算法。

**1. 准备**（和录音分析共用 sherpa-onnx；模型约 330 MB）

```bash
pip install --break-system-packages sherpa-onnx==1.13.8 soundfile onnx
cd "$SPEECH_DIR"
curl -L --retry 2 -o kokoro.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-multi-lang-v1_0.tar.bz2
file kokoro.tar.bz2   # 必须是 bzip2
tar xjf kokoro.tar.bz2 && rm kokoro.tar.bz2
export KOKORO_DIR="$SPEECH_DIR/kokoro-multi-lang-v1_0"
```

用 `Artifact read`（`path: "tools/speak.py"`）取回脚本。没有 ffmpeg 时同上设置 `FFMPEG`。

**2. 导出数据**：ArtifactData `list`，每个集合都带 `out_dir: "$SPEECH_DIR/dump"`：`nodes`、`turns`（limit 1000）、`bank`、`audio`、`config`。

**3. 算出还缺哪些句子，生成音轨**

```bash
python3 speak.py todo dump > todo.json          # stderr 打印"N sentences need audio"；N 为 0 就结束
python3 speak.py synth todo.json out            # 约 1 秒/句（4 线程 CPU）
```

**4. 上传**：`Artifact read` 不能上传，要用 `Artifact publish`：`url` = artifact 地址，`asset: true`，
`file_paths` = `out/*.mp4`（一次最多 25 个；文件必须在工作目录里，先复制进去，比如 `build/audio/`）。
结果里每个文件有一个 id，写成 `ids.json`：`{"<文件名>.mp4": "<id>", ...}`。

**5. 写索引**：`python3 speak.py docs out/manifest.json ids.json docs` 打印 ArtifactData `batch` 的 `writes` 数组，原样用它写入。

**声音**：默认"我"（更自然、改后、口袋本、要说的话）= `af_heart`，"对方" = `am_michael`，工作人员 = `bm_george`，
旅伴角色各有一个（`speak.py` 里的 `VOICES`）。用户想换，就在 `config/app` 里写 `voices: {"me": "am_michael", ...}`，
可选名单见模型元数据 `speaker_names`（英语：`af_*` `am_*` 美式，`bf_*` `bm_*` 英式）。已经生成的不会自动重做：要重做就删掉
对应的 `audio/*` 文档（和资产），再跑一遍。

**配额**：资产上限 5000 个文件、1 GiB。一次运行通常只有 1 个"turns"音轨，几乎不占文件数。
