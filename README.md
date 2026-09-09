# tapnow-cli

通过命令行管理 [TapNow](https://app.tapnow.ai/home) 的个人/团队项目、画布节点和图像/视频生成工作流。一个 JSON 文件对应一个项目需求；文字、参考图与视频节点通过有向无环图连接。

这是独立开发的 **非官方 CLI**，基于登录用户可访问的网页接口。首次交付已实际跑通「创建项目 → 3 个节点 / 2 条连线 → 生图 → 图片作为视频输入 → 结果写回画布 → 下载」。网页协议可能变化，适配器会在无法识别模型模块时停止并报错。

## 安装

需要 Node.js 22+ 和本机 Google Chrome。Windows 推荐 PowerShell 7。

```powershell
cd X:\Projects\Code\tapnow-cli
npm ci
npm link
tapnow --help
```

无需构建。也可以使用 `node bin/tapnow.mjs ...`，不安装全局命令。

## 登录

```powershell
tapnow auth login
tapnow auth status
tapnow orgs
tapnow balance
```

`auth login` 打开独立 Chrome 配置，供本人完成登录。默认目录是用户主目录下 `.tapnow-cli/browser`，会话不会进入代码仓库。其余命令默认使用无头 Chrome。失效后重新登录；若网页刷新令牌失败，命令会明确返回认证错误，不重复提交生成。

可通过 `--profile <目录>` 切换独立账号，通过 `--org <组织ID>` 明确指定组织。已有启用远程调试的 Chrome 可使用 `--cdp http://127.0.0.1:9222`；仅允许本机 CDP，CLI 不关闭已有标签页。不要让两个进程同时使用同一独立 Chrome 配置。

自动化环境也可使用 `TAPNOW_ACCESS_TOKEN` 和 `TAPNOW_ORG_ID`，凭据只能由环境/密钥管理器提供，不放进命令行参数或工作流。此模式直连 API，令牌过期后需由调用者更新。无需浏览器的参数转换目前覆盖 Banana 2/Pro/Lite 和 Veo 3.1 系列基础模式；其他模型使用默认浏览器模式。`auth import` 支持从标准输入导入本人会话 JSON（`accessToken`、可选 `refreshToken`、`orgId`）到独立浏览器，命令只输出身份 ID，不回显令牌。

## 第一个项目

```powershell
tapnow workflow init my-film.json --name "产品宣传片"
tapnow workflow validate my-film.json
tapnow workflow plan my-film.json
tapnow workflow apply my-film.json
tapnow workflow estimate my-film.json
tapnow workflow run my-film.json --execute --max-cost 50
```

`apply` 创建项目、节点、连线并读回验证，不调用生成接口。`estimate` 只查询报价；若视频依赖尚未生成的图片，会标记 deferred，不伪造完整总价。`run` 按拓扑顺序执行，父文本拼入提示词，父图像/视频的第一个结果作为下游输入。

`--max-cost` 限制该状态文件累计保留的**服务端报价**，包括此前已提交任务，并非服务端强制扣费上限。报价缺失、超过预算或参数错误时停止。实际扣费与额度消耗以 TapNow 账单为准。每个节点提交前重新报价，生成请求不会自动重试。

```json
{
  "version": 1,
  "project": {
    "key": "product-film",
    "name": "产品宣传片",
    "description": "先生成主视觉，再生成 4 秒视频",
    "team": false
  },
  "nodes": [
    {
      "id": "hero",
      "type": "image",
      "model": "nano-banana-flash",
      "prompt": "白色影棚中的蓝色立方体，柔和光线，无文字",
      "params": { "aspectRatio": "16:9", "imageSize": "1K" }
    },
    {
      "id": "film",
      "type": "video",
      "model": "veo3.1-lite",
      "mode": "image_to_video",
      "prompt": "立方体缓慢旋转，固定机位",
      "params": {
        "aspectRatio": "16:9", "duration": 4,
        "resolution": "720p", "generateAudio": false
      }
    }
  ],
  "links": [{ "from": "hero", "to": "film" }]
}
```

完整含文本节点的例子在 [examples/image-to-video.json](examples/image-to-video.json)。节点可指定 `title`、`position: {x,y}`、`times`（1–8）、`images` / `videos` HTTPS 输入列表。资产节点可指定 `src`，会跳过生成。高级 `request` 字段可提供已经核对的服务端参数；不允许覆盖上下文、提示词和次数，不应混用不一致的前端参数与服务端参数。

## 多项目与团队

每个需求维护独立 JSON，例如 `product-a.json`、`campaign-b.json`。默认每个文件旁边生成 `*.tapnow-state.json`，记录远端画布 ID、稳定节点 ID、任务 ID、输出和报价。也可通过 `--state <文件>` 指定路径。**保留状态文件**，删除它可能导致重复创建项目/任务。

```powershell
tapnow projects list --limit 30 --offset 0
tapnow projects create "品牌项目" --description "产品系列"
tapnow --org YOUR_ORG_ID projects create "团队项目" --team
tapnow projects get CANVAS_ID
tapnow projects rename CANVAS_ID "新名称"
tapnow projects export CANVAS_ID canvas-backup.json
```

工作流可设置 `project.orgId` 和 `project.team: true`，向对应团队共享。默认项目不公开且不共享给团队。`project.id` 可指向已有画布；CLI 只管理该状态文件对应的节点，保留其他节点和产出。跨组织状态会拒绝执行。团队功能已实现请求字段，首次验收没有修改真实团队成员或权限。

同步不会删除从清单中移除的旧节点/连线，也不会覆盖网页中检测到的提示词/参数改动。导出并核对冲突后再调整需求。已有生成任务的运行不可变；新的生成需求应另建工作流/状态（可用同一个 `project.id`，追加新节点）。本版本不提供删除画布/批量清理命令。

## 模型和参数

```powershell
tapnow models list --type image
tapnow models list --type video
tapnow models show nano-banana-flash
tapnow models show veo3.1-lite
tapnow models refresh current-models.json
tapnow --catalog current-models.json models list
tapnow --catalog current-models.json workflow validate my-film.json
```

内置 2026-09-10 观察到的网页目录快照，共 82 个图像/视频条目，含隐藏模型；条目存在不等于当前账户有权使用或所有模式均已实测。默认浏览器模式读取当前网页的参数转换函数，模式、画幅、分辨率、时长等基础枚举根据目录校验。复杂模式的跨字段限制、可用性及定价仍以平台验证为准。新增模型先刷新目录并通过 `--catalog` 使用。

## 参数调整与请求预览

```powershell
tapnow models params gpt-image-2 --mode image_to_image
tapnow models params seedance-2.0 --mode start_end_to_video
tapnow models params MiniMax-H3 --mode reference_to_video
tapnow workflow configure my-film.json hero --set quality=high --set imageSize=2K
# 预览无误后加 --write；也可 --output new-film.json 写到新文件
tapnow workflow configure my-film.json hero --model gpt-image-2 --reset-params --set aspectRatio=16:9 --write
tapnow workflow prepare my-film.json
```

`models params` 返回该模式的字段、默认值、枚举、参考数量和时长约束。`configure` 校验整个工作流，失败不写文件，默认输出 before/after/resolved；切换模型保留旧参数，显式 `--reset-params` 才清空。`--unset aspectRatio` 移除不适用于首帧模式的画幅，`--mode auto` 按素材选择模式。

| 模型 | 重点差异 |
| --- | --- |
| GPT Image 1 | 最多 4 张参考图、3 种画幅；不接受 GPT Image 2 的 quality/imageSize |
| GPT Image 2 / 2.5 | 最多 16 张参考图；2 支持 low/medium/high，2.5 另有 xhigh/max；1K/2K/4K，auto 必须与 auto 画幅配对 |
| GPT Image 2 / 2.5 自定义像素 | targetWidth/targetHeight 成对、16 的倍数、单边最多 3840、总像素最多 8294400；不与显式 imageSize/aspectRatio 混用 |
| Seedance 2.0 / Fast / Mini | 4–15 秒，单次 1 或 2 个结果；Fast/Mini 仅 480p/720p；标准版另有 1080p/4k；全能参考最多 9 图/3 视频/3 音频 |
| Seedance 2.5 | 4–30 秒、最多 30 图/10 视频/10 音频；video_edit 仅 1 个视频，duration=-1 保留源时长；视频时长按模式校验 |
| MiniMax-H3 | 4–15 秒、768P/2K；最多 9 图/3 视频/3 音频，单视频 2–15 秒、合计最多 15 秒；音频参考需图像或视频陪同 |
| MiniMax-H3-Max | 5–15 秒、480P/768P，仅文生视频和单首帧图生视频 |

大小写按平台枚举校验。首帧需要 1 张图，首尾帧需要 2 张有序图片；画幅由素材决定的模式拒绝显式 aspectRatio。GPT Image、Seedance 和 H3 系列拒绝未支持的参数键，防止拼错却静默执行。其他模型仍允许目录未列出的扩展字段；完整可用性与服务端限制以平台为准。

`prepare` 返回实际转换后的请求，不创建项目或生成任务。保留网页转换后的提示词、图片编辑 scene 和素材角色。有参考视频时长约束的模型，会通过浏览器读取媒体元数据校验真实时长；无法测量就停止。可用 `videoDurations` 数组为直接 videos 提供离线时长检查，但运行前仍重新测量。素材像素、格式、审核和权限仍可能在平台提交时失败。

示例：[GPT Image → Seedance](examples/gpt-image-seedance.json)、[H3 视频](examples/h3-video.json)。已提交清单调整后需使用新工作流/状态，不能复用旧任务生成结果。

## Agent Skills 与机器输出

内置 `tapnow-workflow`（项目、节点、预算和恢复）、`tapnow-image`（图像与 GPT Image）、`tapnow-video`（Seedance/H3 镜头和音画指导）三个可独立使用的技能。

```powershell
tapnow skills list
tapnow skills show tapnow-image
tapnow skills install all --dry-run
tapnow skills install all                         # 当前项目 .agents/skills
tapnow skills install all --global                # Codex 用户目录
tapnow skills install tapnow-image tapnow-video --target claude --global
tapnow skills install all --dir X:\AgentSkills
```

Codex 全局目录为 `$CODEX_HOME/skills`，未设置时为 `~/.codex/skills`；Claude 使用项目或用户的 `.claude/skills`；`--target agents` 使用 `.agents/skills`。`--dir` 指定技能父目录并覆盖默认路径。安装器仅复制本包技能，不下载或执行社区脚本。相同内容重复安装返回 unchanged，不同内容返回 SKILL_CONFLICT，保留本地修改；升级时先比较差异，或安装到新的 `--dir`。安装后重新加载 Agent 会话。

技能遵循 [Agent Skills 规范](https://agentskills.io/specification)，创作指引参考 [OpenAI 公开 imagegen skill](https://github.com/openai/skills/blob/main/skills/.system/imagegen/SKILL.md)、[ByteDance Seedance](https://seed.bytedance.com/en/seedance2_0) 和 [MiniMax 社区模型的官方指南](https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md)。包内保存原创精简指引与来源；外部平台的执行路径和参数不直接套用到 TapNow。

```powershell
tapnow --agent models params gpt-image-2
tapnow --agent commands     # 命令、参数、选项树
tapnow --agent schema       # 工作流 JSON Schema
```

默认成功输出保持原始 JSON；`--agent` 成功输出为 `{ "schemaVersion": 1, "ok": true, "data": ... }`。所有失败在 stderr 输出 `{ "schemaVersion": 1, "ok": false, "error": { "code", "message", "details", "retryable", "next" } }` 并退出 1。参数错误包含 node/model/mode/field/value/expected。未知错误用 COMMAND_FAILED；进度为 stderr JSON 事件。`--help` 和 `--version` 是面向人的文本例外。

Agent 应区分 deferred、报价、提交、服务端完成和视觉验收。schema/prepare/estimate 均不授权费用，生成仍要求 `--execute --max-cost`；计费请求不自动重试。

## 输入素材和结果

```powershell
tapnow assets upload reference.png
tapnow assets download "https://files.tapnow.media/..." hero.png
tapnow jobs status TASK_ID
```

上传支持 PNG/JPEG/WebP/MP4/MOV/MP3/WAV，单文件最大 256 MiB。将返回的 URL 放入节点的 `src`、`images`、`videos` 或 `audios`。直接素材排在链接素材前，链接素材按 links 的顺序排列。下载写入新文件，不覆盖已有文件；仅接受 TapNow 与其存储域名的 HTTPS URL。结果 URL 和任务详情可从运行输出/状态文件获得。

## 中断与恢复

```powershell
# 继续原运行，不重新提交已完成/已知任务
tapnow workflow run my-film.json --execute --max-cost 50 --timeout 900
# 网络故障导致提交结果未知时，查询服务端恢复记录
tapnow jobs recover my-film.json hero
# 已完成的未知提交：指定任务 ID，CLI 核对该节点历史中的结果归属
tapnow jobs attach my-film.json hero TASK_ID
```

提交前先写入 `submitting` 状态；请求成功后保存任务 ID。响应丢失时会保留未知状态，禁止盲目重发。服务端恢复记录可能过期，或任务历史尚未出现，此时必须等待/核查网页。失败任务不会自动退还本地预算预留或重试。锁文件防止同一状态文件被并行使用；进程被强杀留下锁时，先确认没有运行中的进程，再移除该精确 `.lock` 文件。

标准输出为 JSON；执行进度和错误写入 stderr；错误返回非零退出码。

## 开发与验收

```powershell
npm test
npm run check
```

见 [协议与架构](docs/protocol.md) 和 [首次验收记录](docs/acceptance.md)。本项目未发布到 npm；通过 GitHub 私有仓库维护。`npm link` 用于本地安装。
