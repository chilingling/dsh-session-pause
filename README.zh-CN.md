# dsh-session-pause

[English](README.md) | 简体中文

DeepSeek Harness 的暂停插件。用一次点击或一条命令暂停模型活动，范围可以是宿主上的所有会话，也可以是单个会话及其启动的 subagent。暂停范围包括 goal 轮次，以及由 schedule 或 job 通知唤醒的 turn。

暂停不会取消任何操作。恢复后，每个 agent 从暂停点继续执行，不需要补发「继续」消息。设计和取舍见 [docs/design.md](docs/design.md)。

## 安装

```sh
pnpm install && pnpm build
pnpm dsh plugin --profile web add /path/to/dsh-session-pause   # 在 deepseek-harness 仓库中执行
```

`dsh plugin add` 会链接本仓库，并把 bundle 加入 profile。bundle 的 patch 文件 [`cordis.patch.yml`](cordis.patch.yml) 负责挂载插件，并把状态文件放在 `$DSH_HOME/session-pause.json`。修改代码后，需要重新构建并重启该 profile。

## Web 客户端

- **暂停全部**按钮位于侧边栏底部、「设置」上方；侧边栏收起时只显示图标。点击后暂停整个宿主。暂停期间按钮变为**恢复全部**，点击后结束全局暂停。
- 全局暂停期间，会话标题栏下方显示状态提示。提示显示开始时间、等待中的操作数和暂停原因，并提供**恢复**按钮。全局暂停或恢复请求失败时，状态提示也会显示失败原因。
- 输入框工具栏中、模型选择器之前有一个暂停图标，点击可暂停当前会话。当前会话暂停后，该图标变为播放图标，点击后恢复该会话。
- 当前会话暂停期间，输入框上方显示**此会话已暂停**提示条。提示条显示开始时间、该会话自身等待中的操作数和暂停原因，并提供**恢复**按钮。该会话的请求失败时，提示条也会显示失败原因。

所有界面都通过 `sessionPause/follow` Remote 流获取宿主状态。因此，通过命令、其他浏览器标签页发起的暂停，或者页面刷新前已经存在的暂停，都会立即显示。界面文案支持 `zh` 和 `en`。

## 命令

| 命令 | 作用 |
|---|---|
| `/pause-all [reason]` | 暂停整个宿主；重复执行时保留最初的开始时间和原因 |
| `/resume-all` | 结束全局暂停 |
| `/pause-session [reason]` | 暂停接收命令的会话及其启动的 subagent |
| `/resume-session` | 恢复接收命令的会话 |
| `/pause-status` | 显示全局暂停、每个会话的暂停，以及每个等待中的操作 |

`/pause-all`、`/resume-all` 和 `/pause-status` 作用于整个宿主，与接收命令的会话无关。命令输出只有英文。

其他插件可以使用 `ctx.sessionPause` 服务，它提供以下方法和事件：

- `pause({ source, reason? })`、`resume()`
- `pauseSession(sessionId, { source, reason? })`、`resumeSession(sessionId)`
- `status()`、`follow(signal)`、`waitForResume(signal, operation)`
- `session-pause/changed` 事件

除 `waitForResume` 外，上述方法也是 `sessionPause` 命名空间下的 Remote 方法。Remote 描述符写在 [`src/host/remote.ts`](src/host/remote.ts) 中，修改服务方法时必须同步修改。

## 配置

| 字段 | 含义 |
|---|---|
| `stateFile` | 保存暂停状态的 JSON 文件，宿主重启后状态仍然有效；省略时状态只在当前进程内有效 |

插件写入 version 2 格式的状态文件，也能读取只记录全局暂停的 version 1 格式。如果状态文件不是合法 JSON，或者插件不支持其版本号，插件会加载失败，错误信息包含文件路径。

## 行为

全局暂停作用于所有 agent。会话暂停作用于该会话，以及它以 subagent 方式启动的所有会话。如果父会话的 agent 已经不存在，它启动的 subagent 不受该父会话暂停的影响。

全局暂停和会话暂停相互独立。**恢复全部**不会恢复被单独暂停的会话；恢复某个会话也不会结束全局暂停。

暂停期间，插件在以下三个扩展点等待恢复。如果操作被取消，等待立即结束，因此停止按钮仍然有效。

- `agent/pre-step`：agent 在下一个 step 开始前等待，状态保持 `running`。
- `llm/stream`：模型调用在发给 provider 前等待。这也包括 agent step 之外的调用，例如 compaction 和生成会话标题。如果调用没有带会话 id，只有全局暂停会让它等待。
- `agent/request-error`：暂停期间失败的模型请求会等待恢复，例如因断网而中断的流式请求。恢复后立即重试，不经过退避，也不消耗 `dsh-llm-retry` 的重试次数。

正在进行的模型流式响应和已启动的工具会正常结束。暂停期间到达的消息、steer、schedule 投递和 job 通知会进入各 agent 的 inbox，在恢复后处理。

## 已知限制

- 如果宿主在 agent 等待 step 开始时退出，这个 step 已经取出的消息会丢失。重启时，agent loop 会把未完成的 turn 标记为 `interrupted`；goal 需要执行 `/goal resume` 才能继续。
- 暂停中的 agent 在对话和会话列表中仍显示为运行中。实际的暂停状态以状态提示和提示条为准。
- 会话暂停记录会一直保留在状态文件中，直到恢复该会话；会话删除后也是如此。`/pause-status` 会列出这些记录。
- 新会话发送第一条消息之前，Web 输入框会把斜杠命令当作普通消息排队，而不会执行。这时请使用侧边栏按钮。
- 外部 subagent provider（ACP、Codex、Claude Code）在其他产品中运行，不受暂停影响。
