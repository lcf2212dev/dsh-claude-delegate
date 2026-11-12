# dsh-claude-delegate

Bundle package: `@dsh-burn-plugins/dsh-claude-delegate`. License: [MIT](LICENSE).

Standalone DeepSeek Harness plugin that exposes **one** tool, `claude_delegate`:
it delegates a task to a fresh, unattended Claude Code session, with
**model and effort chosen per call**.

It also keeps the host Claude Code CLI on the **newest build** at every DSH
start, so alias-to-model mappings (for example `fable` → Fable 5.2, which needs
Claude Code 2.1.321 or later) never come from a stale launcher.

It does not depend on the official `@deepseek-ai/dsh-subagent-claude-code` bundle,
on any fixed subagent instance, or on any pinned SDK. It talks directly to the
host's Claude Code launcher (`claude -p`), whose version it refreshes
automatically on DSH start (see below) — so there is no SDK version to track.

## How it works

Each call becomes one process:

```
claude -p <task> --model <opus|sonnet|haiku|fable> --effort <low|medium|high|xhigh|max> \
       --dangerously-skip-permissions --output-format stream-json --verbose --no-session-persistence
```

- **Bypass by default**; with `readOnly: true` the child runs with
  `--permission-mode plan` instead of `--dangerously-skip-permissions`
  (no edits, no commands that require approval).
- **`model` and `effort` per call**; defaults come from the row config.
- **Subscription**: ambient credential variables (`ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CODE_API_KEY`) are
  removed so the native OAuth login wins. Turn this off with
  `isolateCredentials: false` and pass the key in `env` if you want to use an API key.
- Its own **`CLAUDE_CODE_TMPDIR`** (default `~/.cache/claude-delegate`), avoiding
  the problem of `/tmp/claude-$UID` belonging to another user.
- cwd = session workspace (or an explicit `cwd`); cancellation tears down the
  process tree (SIGTERM → SIGKILL after 3s).
- **Task report, not a notification reply.** The child prints `stream-json`; the
  wrapper collects the `result` events and returns the one that answers the task.
  A background task that finishes after the agent already answered makes the CLI
  append an extra turn and a second `result` event that only acknowledges the
  notification — returning it (what `--output-format json` does, as it prints the
  last result) lost two worker reports in the 2026-11-11 Bits mission. The
  selection lives in [`result.js`](result.js).
- No built-in timeout: the call blocks until the child exits or is cancelled.

## Keeping the host CLI current

Every DSH start refreshes the host Claude Code build before and in parallel with
the session:

1. **Immediate, offline repair.** On activation the plugin reads the native
   installer store (derived from the `command` symlink, e.g.
   `~/.local/share/claude/versions`) and points that stable launcher symlink at
   the newest build already on disk. A launcher left on an older build — for
   example after a channel switch or a partial update — is fixed without
   network access.
2. **Startup refresh.** Two seconds later it runs
   `<command> install <updateChannel>` in the background and repairs the
   launcher again. Failures (offline, registry error, timeout) are logged and
   never block DSH startup or the delegate tool.
3. **Per-call safety net.** Each delegate call resolves the newest installed
   build directly from the native store, so even a launcher repointed by
   something else during the session still runs the newest build.

Every maintenance outcome is appended to `latest.log` under the plugin's cache
directory (`tmpDir`, default `~/.cache/claude-delegate`), so the last automatic
refresh stays inspectable after a restart.

Only the native installer layout is managed: when `command` is a plain file or a
wrapper (not the stable launcher symlink into `.../versions/<build>`), the plugin
leaves it untouched and skips the refresh. Set `keepLatest: false` to opt out,
or `updateChannel: stable` to follow the stable channel instead of `latest`.

## Tests

```bash
node test/result.test.mjs
```

The suite replays a trimmed capture of a real background-notification run
(`test/fixtures/background-notification.stream.jsonl`): the report must win over
the notification acknowledgement, including when JSON lines are split across
arbitrary chunks.

## Installation

1. Link the package in the profile (e.g. `~/.dsh/profiles/desktop/package.json`):

   ```json
   "@dsh-burn-plugins/dsh-claude-delegate": "link:/path/to/dsh-claude-delegate"
   ```

2. Add `@dsh-burn-plugins/dsh-claude-delegate` to `dsh.profile.bundles`.
3. Run the profile's `pnpm install` (creates the symlink under `node_modules/@local`).
4. HMR recomposes the profile and the tool appears on the next model request.

## Configuration (row `claude-delegate`)

| field | default | meaning |
|---|---|---|
| `command` | `claude` | stable Claude Code launcher (use an absolute path if the Host `PATH` has wrappers) |
| `model` | `opus` | alias used when the call omits `model` |
| `effort` | `high` | effort used when the call omits `effort` |
| `tmpDir` | `""` → `~/.cache/claude-delegate` | exported as `CLAUDE_CODE_TMPDIR` |
| `env` | `{}` | extra env layered over the host environment |
| `timeoutMs` | `0` | declarative per-call limit; `0` does not cap |
| `isolateCredentials` | `true` | removes ambient credentials so the subscription is used |
| `keepLatest` | `true` | repair/refresh the native Claude Code launcher at DSH start |
| `updateChannel` | `latest` | startup refresh channel: `latest`, `stable`, or `off` |
| `versionsDir` | `""` | native version store when it cannot be derived from `command` |
| `updateTimeoutMs` | `300000` | upper bound for one startup refresh |

The package ships no machine-specific value: without an override, every field
uses the default above. To customize it, override the row in your profile patch
(e.g. `~/.dsh/profiles/desktop/cordis.patch.yml`), without editing this
repository:

```yaml
- id: claude-delegate
  name: "@dsh-burn-plugins/dsh-claude-delegate"
  config:
    command: /absolute/path/to/claude
    model: sonnet
    effort: medium
```

The override `config` replaces the row's config entirely; omitted fields fall
back to the defaults.

## Tool parameters

- `task` *(required)* — self-contained task; the child does not see the conversation.
- `model` — `opus` \| `sonnet` \| `haiku` \| `fable` (each alias resolves to the latest build).
  `fable` is the most capable and most expensive model: it resolves to Fable 5.2 on
  Claude Code 2.1.321 or later (earlier builds resolve it to an older Fable) and,
  depending on the plan, bills usage credits — `claude -p` never asks before billing them.
  `fable` requires this package at **0.1.1 or later**; an older build rejects the alias.
- `effort` — `low` \| `medium` \| `high` \| `xhigh` \| `max` (the model may clamp
  a level it does not support).
- `cwd` — absolute directory; omitted = session workspace.
- `readOnly` — boolean, default `false`. When `true`, it swaps
  `--dangerously-skip-permissions` for `--permission-mode plan` (read-only/planning
  only; the child neither edits files nor runs commands that require approval).

## Requirements

- `claude` installed and logged in on the host (subscription) or a credential in `env`.
- No `@deepseek-ai` subagent package installed.
- Network access for the startup refresh; an offline start still uses the newest
  build already installed.
- The native Claude Code installer layout for automatic launcher repair; a
  wrapper or package-manager command is left untouched.

## Limitations

- Single execution: no continuation, resume, streaming, or parent context.
- Blocking: the parent agent waits for the call to finish (cancel from the UI).
- The CLI refresh runs when DSH starts; a long-running Host does not poll for new
  builds.
- If `claude update` changes the flags used (`--effort`,
  `--output-format stream-json`, `--verbose`, `--no-session-persistence`), adjust
  the array in `index.js`.
- The result selection assumes the CLI keeps emitting one `result` event per
  finished turn and marks notification turns with `origin.kind ===
  "task-notification"` (Claude Code 2.1.32x). A future CLI that stops marking
  them falls back to the last result, as before.
