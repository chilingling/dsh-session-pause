# dsh-session-pause 设计

## 目标

一次操作暂停宿主上所有 agent 的模型活动，包括主会话、后台 subagent、goal 轮次、schedule 唤醒和 job 完成通知触发的 turn；恢复后，每个 agent 从暂停点继续执行，不需要用户补发「继续」消息。典型场景是带着笔记本离线移动：暂停前网络可能还在，暂停期间网络断开，恢复前网络回来。

也可以只暂停单个会话及其启动的 subagent，其他会话照常运行。典型场景是用户想先检查某个会话的中间结果，再让它继续。

不在范围内：暂停本地进程（后台 bash job 和已启动的工具照常运行）、暂停外部 subagent provider（ACP、Codex、Claude Code 在其他产品中运行）、暂停 schedule 的计时。

## 方案

插件采用「冻结」语义：不调用 `agent.cancel()`，而是在三个挂起点等待恢复。

| 挂起点 | 位置 | 暂停期间的行为 | 恢复后的行为 |
|---|---|---|---|
| step 入口 | `agent/pre-step` waterfall | 在调用 `next()` 前等待 | 调用 `next()`，step 按原样进入 |
| 模型调用入口 | `llm/stream` waterfall（`prepend: true`） | 在调用 `next()` 前等待；覆盖 compaction、会话标题等不经过 agent loop 的调用 | 开始真实的 provider 请求 |
| 失败的模型请求 | `agent/request-error` waterfall（`prepend: true`，排在 `dsh-llm-retry` 之前） | 暂停期间出现的任何请求失败都等待恢复 | 立即返回 `{ kind: 'retry' }`，不经过退避，不消耗 `dsh-llm-retry` 的重试次数 |

挂起点是否等待，取决于操作是否被暂停「覆盖」。满足以下任一条件时，操作被覆盖：宿主处于全局暂停；操作所属会话或其上游父会话被单独暂停。上游父会话沿 `session.header` 的 `parentSession` 向上追溯，只包含 `origin: 'subagent'` 的会话（fork 不算），且只经过仍有 live agent 的会话。父 agent 已不存在时停止追溯。`llm/stream` 挂起点使用请求的 `sessionId`；请求不带会话 id 时，只有全局暂停会让它等待。

三个挂起点都与操作自身的 `AbortSignal` 竞争：用户在暂停期间点击停止时，挂起立即结束，agent loop 按普通取消收尾。

不采用取消式暂停（`cancel({ keepInbox: true })` 加 pre-step `reject`），因为它有三个插件无法消除的副作用：goal 轮次中止后，驱动器会把 goal 持久化为 `paused`；本地 subagent 取消后会结算，并唤醒父会话；pre-step 已 claim 的消息会丢失。此外，恢复时每个被中断的会话都需要一条模型可见的「继续」消息。

## 暂停语义

| 对象 | 暂停期间 | 恢复后 |
|---|---|---|
| 正在流式返回的模型请求 | 继续接收；网络断开时失败，转入失败请求挂起点 | 立即重试 |
| 已启动的工具 | 运行到结束；依赖网络的工具返回错误结果 | 模型在下一个 step 看到这些结果 |
| 下一个 step | 在 step 入口挂起，agent 状态保持 `running` | 继续同一个 turn |
| 用户新发的消息、steer | 进入 inbox，按原有语义排队 | 在下一个 step 或下一个 turn 处理 |
| goal | 驱动器只在 agent `idle` 时排入下一轮，冻结期间不会推进 | 按原有节奏继续，goal 阶段不变 |
| 后台 subagent | 同样在挂起点等待，不结算，不唤醒父会话 | 继续执行 |
| schedule | 计时器照常到期，`followup` 进入 inbox；空闲 agent 被唤醒后在 step 入口挂起 | 处理到期投递 |
| job 完成通知 | 进入 inbox，或唤醒 agent 后在 step 入口挂起 | 处理通知 |
| 停止按钮 | 立即生效 | — |
| 重复暂停或恢复 | 幂等，返回当前状态 | — |

全局暂停与会话暂停相互独立：结束全局暂停时，被单独暂停的会话继续挂起；恢复某个会话时，全局暂停仍然生效。每次状态变化后，插件释放所有不再被暂停覆盖的挂起操作。

## 组件

`SessionPause` 服务（`ctx.sessionPause`）持有暂停状态，并提供：

- `pause(request)`：进入全局暂停；已暂停时不改变 `since` 和 `reason`。
- `resume()`：结束全局暂停，释放不再被覆盖的挂起。
- `pauseSession(sessionId, request)`：暂停单个会话；该会话已暂停时不改变 `since` 和 `reason`。会话不需要有 live agent。
- `resumeSession(sessionId)`：结束该会话的暂停，释放不再被覆盖的挂起。
- `status()`：返回 `{ host, sessions, held }`：全局暂停（未暂停时为 `null`）、按暂停顺序排列的会话暂停，以及当前挂起的操作列表（挂起点、会话 id、开始等待的时间）。不带会话 id 的 `llm-stream` 请求在列表中没有会话 id。
- `waitForResume(signal, operation)`：供挂起点和其他插件使用；操作不再被覆盖时返回 `true`，信号先中止时返回 `false`。
- `session-pause/changed` 事件：每次状态变化写入状态文件后发出。

状态变更按调用顺序串行执行，并且先写状态文件再生效：写入失败时，调用方收到错误，宿主保持原状态。插件卸载时释放所有挂起，被挂起的操作继续执行。

持久化：配置了 `stateFile` 时，状态写入该 JSON 文件（`{ version: 2, host, sessions }`），插件加载时读取。宿主在暂停期间重启后仍保持暂停，避免重启后立即发起注定失败的请求。插件仍能读取只记录全局暂停的 version 1 文件（`{ version: 1, paused, since, source, reason }`），下一次状态变化时写成 version 2。插件不支持该文件版本或内容无效时，加载会失败并报告文件路径。

命令（`dsh-commands` 可用时注册）：`/pause-all [reason]`、`/resume-all`、`/pause-status` 作用于整个宿主，与接收命令的会话无关；`/pause-session [reason]`、`/resume-session` 作用于接收命令的会话。

Remote API：`SessionPause` 继承 `TypertRemoteService`，`pause`、`resume`、`pauseSession`、`resumeSession`、`status` 和流式的 `follow` 是 `sessionPause` 命名空间的 Remote 方法。Typert 生成器只在 harness 仓库内运行，所以描述符和 Zod codec 在 `src/host/remote.ts` 中手写，修改服务方法时必须同步修改。`follow` 先推送一次当前状态，之后在每次状态变化和挂起列表变化时推送；消费方读取慢于变化时，多次变化合并为一次推送。插件卸载时流结束。

Web 客户端：

- 一键按钮注册在 `sidebar.footer.action`，位于「设置」上方，窄栏模式只显示图标。未暂停时显示「暂停全部」，暂停时显示「恢复全部」并使用警示色。状态未知时（首个状态到达前、状态流失败后）按钮禁用。
- 状态提示注册在 `shell.overlay`，固定在会话标题栏下方居中，只在全局暂停时显示开始时间、等待中的操作数、暂停原因和「恢复」按钮。全局暂停或恢复请求失败时显示失败原因。
- 单会话按钮注册在 `conversation.input.right`，位于输入框工具栏、模型选择器之前，只显示图标。当前会话未被单独暂停时为暂停图标，被单独暂停时为播放图标并使用警示色。
- 单会话提示条注册在 `conversation.input.dock`，位于输入框上方，只在当前会话被单独暂停时显示开始时间、该会话自身等待中的操作数（不含 subagent）、暂停原因和「恢复」按钮。该会话的请求失败时显示失败原因。
- 所有界面共用一个控制器。单会话界面通过 slot 的 `inject(sessionId)` 获取按会话派生的状态源，以及已绑定会话 id 的暂停和恢复操作。控制器通过 `ctx.remote.$stream` 订阅 `follow`，断线后由网关重连。按钮、命令和其他标签页的状态同步都来自同一条宿主流。请求进行中时忽略重复点击。
- 文案注册在 `sessionPause` locale 命名空间，提供 `zh` 和 `en`；时间按字典 `locale` 字段指定的地区格式化。

## 配置

| 字段 | 含义 |
|---|---|
| `stateFile` | 暂停状态文件；省略时状态只在进程内有效。bundle 写入 `$DSH_HOME/session-pause.json` |

## 已知限制

- 宿主在 step 入口挂起期间退出时，已 claim 但尚未写成 `user/message` 的消息会丢失（claim 本身是持久化的 `agent/inbox/spliced`）。重启时 agent loop 会把未完成的 turn 修复为 `interrupted`；goal 在 `agent/created` 时被 disarm，需要手动 `/goal resume`。
- step 入口挂起发生在工具集解析和 system prompt 组装之后；长时间挂起后，system prompt 中与时间相关的内容可能过期。runtime context 在每次请求前刷新。
- 前台工具如果在等待被冻结的 subagent，可能触发该工具自身的超时。
- 冻结期间会话和会话列表仍显示为 `running`，思考计时也继续增长；实际状态以暂停状态提示为准。
- 新会话发送第一条消息之前，Web 输入框会把斜杠命令当作普通消息排队，而不会执行。这时请使用侧边栏按钮。
- 命令输出是英文，不随界面语言切换。
- 外部 subagent provider 不经过本插件的挂起点，因此不受暂停影响。
- 会话暂停追溯父会话时只经过 live agent：父会话的 agent 已卸载、而 subagent 仍在运行时，subagent 不受父会话暂停的影响。
- 宿主没有会话删除事件，已删除会话的暂停记录会保留在状态文件中，直到恢复该会话；`/pause-status` 会列出它。
- 单会话提示条中的等待数只统计该会话自身的操作；被挂起的 subagent 只在 `/pause-status` 和全局状态中可见。

## 分阶段计划

已实现宿主插件（服务、三个挂起点、全局与单会话暂停、状态文件、命令）和 Web 客户端（Remote API、全局按钮与状态提示、单会话按钮与提示条）。验证方式：

- 使用真实 agent loop 和 mock adapter 的组合测试：暂停后不发出请求；暂停期间失败的请求在恢复后重试且不产生 `llm/retry`；停止按钮在挂起期间生效；单会话暂停只挂起该会话及其 subagent，且不随全局恢复而解除；状态文件在重新加载后保持暂停，并能读取 version 1；插件能通过 Loader 加载。
- `follow` 流和 codec 的单元测试，以及客户端控制器的单元测试。
- 在隔离 Harness home 的 Web 宿主上，用真实模型验证主会话与后台 subagent 的冻结和恢复、暂停后断网的请求重试、goal 不被 disarm，以及按钮、状态提示和命令之间的状态同步。

后续计划：

1. 快捷键：通过 `ctx.shortcuts` 注册暂停和恢复。
2. 重启恢复：挂起开始时把 claim 的消息写回 inbox，恢复时取回；记录暂停时处于 active 的 goal，在重启后恢复时重新 arm；对 turn 被修复为 `interrupted` 的会话补发继续消息。
3. 可选的自动模式：宿主端探测模型 API 可达性，断网时自动暂停、联网时自动恢复；恢复时重建 provider 的 keep-alive 连接。

## 设计参考

- OpenHands SDK `conversation.pause()`：执行完当前 step 后在 step 之间暂停，暂停期间可以继续发消息。本插件的 step 入口挂起采用相同语义。
- Temporal Workflow Pause 与 Activity Unpause：暂停期间计时器继续走、投递缓冲到恢复后处理；恢复后立即开始下一次尝试并丢弃剩余退避。本插件的 schedule 行为和失败请求挂起点采用相同语义。不采用 Temporal 把取消推迟到恢复后才生效的做法。
- AutoGen `Team.pause()`：暂停传递给所有参与者。本插件对宿主上所有 agent 生效，因此覆盖 subagent 和 Agent Teams 成员。
- LangGraph checkpointer、OpenAI Agents SDK `RunState`：持久化的暂停记录带 schema 版本号。
