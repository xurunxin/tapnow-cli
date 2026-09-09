# 协议与架构

观察日期：2026-09-10；网页版本：2.16.2。来源为 [TapNow 实际应用](https://app.tapnow.ai/home) 的 UI、网络请求以及页面加载的模型配置/转换器。没有使用第三方账户或调用模型厂商独立 API，生成消耗当前 TapNow 账户的额度。

## 模块

- `client.mjs`：独立浏览器/CDP 或环境令牌传输；固定 TapNow API origin；组织隔离；响应信封校验；不自动重试写请求。
- `models.mjs`：目录校验；浏览器读取网页转换器；已核对的有限无浏览器适配；账单预估。
- `workflow.mjs`：严格清单校验、DAG、稳定节点身份、增量同步、读回验证、互斥状态文件、异步任务与结果写回。
- `assets.mjs`：签名 URL 上传、结果下载。存储请求不携带账户 Authorization。
- `bin/tapnow.mjs`：命令路由和 JSON I/O。

## 实测接口

| 用途 | 方法与路径 | 关键约定 |
| --- | --- | --- |
| 身份 | `GET /api/public/v1/users/me` | `data.user_id`, `data.org_id` |
| 组织 | `GET /api/public/v1/organizations` | 显式 `X-Org-ID` 选择上下文 |
| 积分 | `GET /api/billing/v2/wallet/balance` | 余额查询 |
| 项目列表/创建 | `GET/POST /api/canvas/v1/canvases` | `name`, `description`, `is_public`, `is_shared_with_org` |
| 项目详情/更新 | `GET/PATCH /api/canvas/v1/canvases/{id}` | `with_nodes=true&with_connections=true` |
| 节点 | `POST .../{id}/nodes:batchActions` | `actions: [{action:"create",creates:[]},{action:"update",updates:[]}]` |
| 连线 | `POST .../{id}/connections:batchActions` | `source`, `target`, `source_handle:"right"`, `target_handle:"left"` |
| 预估 | `POST /api/billing/v2/estimate` | `GT_IMAGE`/`GT_VIDEO`, `usageQuantity`, `imageParams`/`videoParams` |
| 生成 | `POST /api/conversation/v1/generations/image` 或 `/video` | `data.result.ids`；`metadata`/`context` 关联画布节点 |
| 任务 | `GET /api/conversation/v1/generations/tasks?ids=...` | `pending`/`completed`/`failed`；结果既可能为数组，也可能为 `outputs.image_urls/video_urls` |
| 恢复 | `POST /api/conversation/v1/generations/tasks/recoverable` | `nodeids`, `types`；记录可能为空/过期 |
| 节点历史 | `GET .../{canvas}/nodes/{node}/generation-history` | `items[].resources[].file_url` 可核对完成结果归属 |
| 上传初始化 | `POST /api/conversation/v1/file/upload-url` | MD5、名称、MIME、大小；返回签名上传 URL |
| 上传确认 | `PUT /api/conversation/v1/file/upload-url/{file_id}` | 上传后确认 |

HTTP 成功不等于业务成功，必须校验 `code`。业务错误只输出 HTTP、code、request ID，避免原始服务端错误包含凭据。401 不自动重复写请求。

## 模型目录与转换

网页入口 script 指向 `fe-assets.tapnow.media`。浏览器适配器从当前入口定位 `vendor-packages-*.js`，在同一站点上下文 import 并寻找模型目录/转换器。源码变更后特征检测失败会中止。仓库只保存必要的模型元数据快照，不提交下载的站点 JS、账号状态或请求日志。

复杂视频模式的输入字段由网页转换器产生，CLI 不再叠加通用 images 字段。直接令牌模式只有明确实现的基础转换，其他模型需要默认浏览器或用户核对后的 `request`。

v0.2.0 的 `parameters.mjs` 将目录的模式、枚举、reference ranges、aspectRatioPolicy 和视频时长规则用于校验。GPT 自定义像素约束来自同一网页构建的尺寸处理逻辑；CLI 拒绝会被静默舍入的值。聚焦模型的未知字段拒绝执行，其他模型扩展字段仍由网页适配器处理。

网页转换后的 prompt 优先于原始 prompt，保留 Seedance/H3 素材标签转换。图像的 image-edit scene 也保留。报价将带角色的输入对象转换成 URL 数组，并处理 H3 的 first/last_frame_image_url、reference_*_urls 别名，匹配网页报价构造。

有 referenceVideoDurationRange 的模型在生成/预览前通过 HTMLVideoElement 测量实际输入时长，读取失败即停止。清单 videoDurations 只用于提前发现错误，不能替代真实测量。同一 CLI 会话缓存已测 URL；可变 URL 的内容在会话内不应更换。

## 运行边界

同一清单按依赖顺序串行生成，支持中断续跑。`times` 可请求多份结果，但下游默认取每个父节点的首个结果，不自动做笛卡尔积。没有跨机器分布式锁；不要把同一个状态文件拷贝到两台机器并行执行。

节点接口没有在此适配器中验证到条件更新/事务能力；因此 CLI 在同步前后读回并检测配置冲突，但无法保证与网页同时编辑时的强并发隔离。建议执行期间停止对同一画布的手动编辑。已提交运行拒绝修改清单，避免旧结果被误用于新要求。

费用阈值是累计报价控制，不是平台级强制预算。对于按实际用量计费、动态路由或特殊模型，最终账单可能与报价不同。首次验收只覆盖明确的固定输出规格。
