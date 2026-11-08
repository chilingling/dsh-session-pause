# dsh-session-pause

English | [简体中文](README.zh-CN.md)

A DeepSeek Harness bundle that pauses model activity with one click or command — of every Session on the host, or of one Session and the subagents it starts — including goal rounds and turns woken by schedules or job notices, and resumes each one where it stopped. Nothing is cancelled: held Agents continue their turns after resume without a "continue" message. Design and rationale: [docs/design.md](docs/design.md).

## Install

Install a release from GitHub:

```sh
dsh plugin --profile web add github:chilingling/dsh-session-pause#v0.4.0
```

Version 0.4.0 requires DeepSeek Harness 0.2.2-alpha.2 or a later 0.2 release. For DeepSeek Harness 0.2.1 releases, install `#v0.3.0`.

pnpm builds the plugin through its `prepare` script during installation, and blocks that script until it is allowed. On the first attempt, add the key pnpm prints under `allowBuilds` in the profile's `pnpm-workspace.yaml` and run the command again; the Web **Plugins** page offers **Allow these scripts and retry** instead.

The `main` branch requires DeepSeek Harness 0.2.2-rc.1 or a later 0.2 release. To develop from a local checkout:

```sh
pnpm install && pnpm build
pnpm dsh plugin --profile web add /path/to/dsh-session-pause   # from a deepseek-harness checkout
```

`dsh plugin add` links the checkout and appends the bundle to the profile. After code changes, rebuild and restart the profile.

Either way, the bundle's patch [`cordis.patch.yml`](cordis.patch.yml) mounts the plugin with its state file at `$DSH_HOME/session-pause.json`.

## Web client

- **Pause all** sits in the sidebar foot above Settings (icon only in the collapsed rail). It pauses the whole host; while paused it reads **Resume all** and ends the host-wide pause.
- A status pill appears below the Session header while the host is paused: since when, how many operations wait, the pause reason, and a **Resume** action. It also reports a failed host-wide pause or resume request.
- A pause icon in the composer toolbar, before the model selector, pauses the Session in view; while that Session is paused it turns into a play icon that resumes it.
- A **This session is paused** strip above the composer shows while the Session in view is paused: since when, how many of its own operations wait, the reason, and a **Resume** action. It also reports a failed request for this Session.

All surfaces follow the host through the `sessionPause/follow` Remote stream, so a pause started from a command, another browser tab, or before a page reload shows up at once. Copy is localized for `zh` and `en`.

## Commands

| Command | Effect |
|---|---|
| `/pause-all [reason]` | Pause the whole host; pausing again keeps the original start time and reason |
| `/resume-all` | Resume every held operation |
| `/pause-session [reason]` | Pause the Session that receives the command and the subagents it starts |
| `/resume-session` | Resume the Session that receives the command |
| `/pause-status` | Show the host-wide pause, each Session pause, and each held operation |

`/pause-all`, `/resume-all`, and `/pause-status` act on the whole host regardless of the Session that receives them; command output is English. Other plugins use the `ctx.sessionPause` service: `pause({ source, reason? })`, `resume()`, `pauseSession(sessionId, { source, reason? })`, `resumeSession(sessionId)`, `status()`, `follow(signal)`, `waitForResume(signal, operation)`, and the `session-pause/changed` event. All but `waitForResume` are also Remote methods of the `sessionPause` namespace, whose descriptors live in [`src/host/remote.ts`](src/host/remote.ts) and must change together with the service methods.

## Configuration

| Field | Meaning |
|---|---|
| `stateFile` | JSON file holding the pause across host restarts; omission keeps the pause in this process only |

The plugin writes version 2 of the state file and still reads version 1, which held only the host-wide pause. A state file that is not JSON or holds another version fails the plugin load with its path.

## Behavior

The host-wide pause covers every Agent. A Session pause covers that Session and every Session it started as a subagent, as far as their Agents are live. The two kinds begin and end independently: **Resume all** leaves individually paused Sessions paused, and resuming a Session does not lift the host-wide pause.

While a pause covers an operation, three extension points wait for resume, and each wait ends at once when its operation is cancelled, so the stop button keeps working:

- `agent/pre-step`: an Agent waits before its next step; its status stays `running`.
- `llm/stream`: a model call waits before reaching its provider, including calls made outside an Agent step such as compaction and Session titles. A call that names no Session waits only for the host-wide pause.
- `agent/request-error`: a model request that fails during the pause, such as a stream cut by lost connectivity, waits and is retried at resume without backoff and without counting against `dsh-llm-retry`.

Running model streams and tools settle normally. Messages, steering, schedule deliveries, and job notices that arrive during the pause queue in each Agent's inbox and run after resume.

## Known limitations

- If the host exits while an Agent waits before a step, the messages claimed for that step are lost; the loop repairs the open turn as `interrupted` on restart, and goals need `/goal resume`.
- Held Agents still show as running in the conversation and the Session list; the status pill and the dock strip report what is held.
- A Session pause stays in the state file until it is resumed, even after the Session is deleted; `/pause-status` lists it.
- A slash command typed before a new Session's first message has been created is queued as an ordinary message instead of running; use the sidebar button there.
- External subagent providers (ACP, Codex, Claude Code) run in other products and are not held.
