# dsh-claude-delegate

Bundle package: `@dsh-burn-plugins/dsh-claude-delegate`. License: [MIT](LICENSE).

Standalone DeepSeek Harness plugin that exposes **one** tool, `claude_delegate`:
it delegates a task to a fresh, unattended Claude Code session, with
**model and effort chosen per call**.

It does not depend on the official `@deepseek-ai/dsh-subagent-claude-code` bundle,
on any fixed subagent instance, or on any pinned SDK. It talks directly to the
host's Claude Code launcher (`claude -p`), which the user updates themselves
(`claude update`) — so there is no SDK version to track.

## How it works

Each call becomes one process:

```
claude -p <task> --model <opus|sonnet|haiku> --effort <low|medium|high|xhigh|max> \
       --dangerously-skip-permissions --output-format json --no-session-persistence
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
- No built-in timeout: the call blocks until the child exits or is cancelled.

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
- `model` — `opus` \| `sonnet` \| `haiku` (each alias resolves to the latest build).
- `effort` — `low` \| `medium` \| `high` \| `xhigh` \| `max` (the model may clamp
  a level it does not support).
- `cwd` — absolute directory; omitted = session workspace.
- `readOnly` — boolean, default `false`. When `true`, it swaps
  `--dangerously-skip-permissions` for `--permission-mode plan` (read-only/planning
  only; the child neither edits files nor runs commands that require approval).

## Requirements

- `claude` installed and logged in on the host (subscription) or a credential in `env`.
- No `@deepseek-ai` subagent package installed.

## Limitations

- Single execution: no continuation, resume, streaming, or parent context.
- Blocking: the parent agent waits for the call to finish (cancel from the UI).
- If `claude update` changes the flags used (`--effort`,
  `--no-session-persistence`), adjust the array in `index.js`.
