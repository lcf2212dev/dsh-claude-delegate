/**
 * Claude delegate — one model-facing tool that runs a fresh, unattended
 * Claude Code session through the host `claude` CLI.
 *
 * Why the CLI instead of `@anthropic-ai/claude-agent-sdk`: the host launcher
 * updates daily, so the delegate never pins an SDK build. `command` points at
 * the stable launcher symlink (e.g. `~/.local/bin/claude`), not the versioned
 * binary and not a wrapper that injects flags of its own.
 *
 * The plugin also keeps that launcher on the newest installed Claude Code build:
 * activation repairs the symlink offline, a background `install <channel>` runs
 * on every DSH start, and each call resolves the newest installed binary. Set
 * `keepLatest: false` (or `updateChannel: off`) to opt out.
 *
 * One call = one `claude -p` process: no continuation, no resume, no shared
 * context with the caller. The tool blocks until the child exits and returns
 * only the final answer text.
 *
 * The child prints `--output-format stream-json`; the wrapper collects the
 * `result` events and returns the answer of the task itself. A background task
 * that finishes after the agent answered makes the CLI append an extra turn and
 * a second `result` event that only acknowledges the notification: returning
 * that event (what `--output-format json` does, as it prints the last result)
 * replaced two worker reports on 2026-11-11. `result.js` selects the last real
 * result instead.
 *
 * @module @dsh-burn-plugins/dsh-claude-delegate
 */

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { createResultCollector, selectResultEvent } from './result.js'

export const name = 'claude-delegate'
export const inject = ['tools', 'workingDirectory']

/**
 * Model aliases accepted by the Claude Code CLI; each resolves to the latest build.
 * `fable` resolves to Fable 5.2 on Claude Code 2.1.321 or later (earlier builds
 * resolve it to an older Fable) and, depending on the plan, bills usage credits.
 */
const MODELS = ['opus', 'sonnet', 'haiku', 'fable']
/** Effort levels accepted by `--effort` (newer CLI builds may clamp silently). */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Ambient credentials removed so the child uses the native subscription login. */
const CREDENTIAL_ENV = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'CLAUDE_CODE_API_KEY'
]
/**
 * Bytes kept for the stderr tail before it is dropped. stdout is parsed
 * incrementally by `result.js`, so it is never accumulated.
 */
const MAX_STREAM_BYTES = 8 * 1024 * 1024
/** Grace between SIGTERM and SIGKILL when a run is cancelled. */
const KILL_GRACE_MS = 3_000
/** Delay before the startup network refresh so it never competes with boot. */
const STARTUP_DELAY_MS = 2_000
/** First Claude Code build whose `fable` alias resolves to Fable 5.2. */
const MIN_FABLE_52 = '2.1.321'
/** Native installer directory names: an exact major.minor.patch build. */
const VERSION_NAME = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
/** Captured install output per stream before the tail is dropped. */
const MAX_INSTALL_OUTPUT = 64 * 1024
/** Default upper bound for one startup refresh. */
const DEFAULT_UPDATE_TIMEOUT_MS = 300_000
/** File that records every maintenance outcome next to CLAUDE_CODE_TMPDIR. */
const STATUS_LOG_NAME = 'latest.log'
/** The status log restarts from empty once it grows past this size. */
const STATUS_LOG_MAX_BYTES = 128 * 1024

export const Config = z.object({
	/** Executable used for every run; the stable launcher, not a versioned path. */
	command: z.string().default('claude'),
	/** Default model alias when the call omits `model`. */
	model: z.string().default('opus'),
	/** Default effort level when the call omits `effort`. */
	effort: z.string().default('high'),
	/** User-owned temp root exported as CLAUDE_CODE_TMPDIR; empty means ~/.cache/claude-delegate. */
	tmpDir: z.string().default(''),
	/** Extra environment entries layered over the scrubbed parent environment. */
	env: z.dict(z.string()).default({}),
	/** Optional declarative call budget in milliseconds; 0 leaves calls uncapped. */
	timeoutMs: z.number().default(0),
	/** Strip ambient Anthropic credentials so the subscription login wins. */
	isolateCredentials: z.boolean().default(true),
	/** Keep the host Claude Code launcher on the newest installed build. */
	keepLatest: z.boolean().default(true),
	/** Install channel for the startup refresh: "latest", "stable", or "off". */
	updateChannel: z.string().default('latest'),
	/** Native version store; empty derives it from the launcher symlink. */
	versionsDir: z.string().default(''),
	/** Upper bound for one startup refresh in milliseconds. */
	updateTimeoutMs: z.number().default(DEFAULT_UPDATE_TIMEOUT_MS)
})

/** @param {string} value @returns {string} */
function trimTail(value) {
	return value.length > 2_000 ? value.slice(-2_000) : value
}

/**
 * Build the child environment: parent environment minus ambient credentials,
 * a user-owned CLAUDE_CODE_TMPDIR, then the configured overlay.
 * @param {any} config
 * @returns {NodeJS.ProcessEnv}
 */
function childEnvironment(config) {
	const env = { ...process.env }
	if (config.isolateCredentials) {
		for (const key of CREDENTIAL_ENV) delete env[key]
	}
	const tmpDir = config.tmpDir === '' ? path.join(os.homedir(), '.cache', 'claude-delegate') : config.tmpDir
	mkdirSync(tmpDir, { recursive: true, mode: 0o700 })
	env.CLAUDE_CODE_TMPDIR = tmpDir
	Object.assign(env, config.env)
	return env
}

/**
 * Parse the single JSON object printed by `--output-format json`, tolerating
 * unrelated leading lines from a launcher wrapper.
 * @param {string} stdout
 * @returns {any}
 */
function parseJsonOutput(stdout) {
	const text = stdout.trim()
	if (text === '') throw new Error('claude_delegate: Claude Code printed no output')
	const candidates = [text]
	const firstBrace = text.indexOf('{')
	if (firstBrace > 0) candidates.push(text.slice(firstBrace))
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate)
		} catch {
			// try the next candidate
		}
	}
	throw new Error(`claude_delegate: could not parse Claude Code output: ${trimTail(text)}`)
}

/**
 * Run one `claude` process and settle with its stdout.
 * @param {{command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal}} spec
 * @returns {Promise<string>}
 */
function runClaude(spec) {
	const child = spawn(spec.command, spec.args, {
		cwd: spec.cwd,
		env: spec.env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	})
	const stdout = createResultCollector()
	const stdoutDecoder = new StringDecoder('utf8')
	const stderrDecoder = new StringDecoder('utf8')
	let stderr = ''
	let settled = false
	let killTimer
	const append = (current, chunk) =>
		current.length < MAX_STREAM_BYTES ? current + chunk.toString('utf8') : current
	const killTree = (signal) => {
		try {
			process.kill(-child.pid, signal)
		} catch {
			try {
				child.kill(signal)
			} catch {
				// already gone
			}
		}
	}
	return new Promise((resolve, reject) => {
		const finish = (settle, value) => {
			if (settled) return
			settled = true
			clearTimeout(killTimer)
			spec.signal.removeEventListener('abort', onAbort)
			settle(value)
		}
		const onAbort = () => {
			killTree('SIGTERM')
			killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS)
			killTimer.unref?.()
		}
		if (spec.signal.aborted) {
			finish(reject, new Error('claude_delegate: cancelled before the Claude Code run started'))
			return
		}
		spec.signal.addEventListener('abort', onAbort, { once: true })
		// JSONL lines and reports are UTF-8: a chunk may end inside a multi-byte
		// character, so decode through StringDecoder instead of per-chunk toString.
		child.stdout.on('data', (chunk) => {
			stdout.feed(stdoutDecoder.write(chunk))
		})
		child.stderr.on('data', (chunk) => {
			stderr = append(stderr, stderrDecoder.write(chunk))
		})
		child.on('error', (error) => {
			finish(
				reject,
				new Error(
					`claude_delegate: could not start ${JSON.stringify(spec.command)}: ${error.message}. Set \`command\` on the claude-delegate row to the Claude Code launcher path.`
				)
			)
		})
		child.on('close', (code, signal) => {
			if (spec.signal.aborted) {
				finish(reject, new Error('claude_delegate: the Claude Code run was cancelled'))
				return
			}
			stdout.feed(stdoutDecoder.end())
			stdout.finish()
			let parsed = selectResultEvent(stdout.resultEvents())
			if (parsed === null) {
				// A wrapper or an older build may still print one plain JSON object.
				try {
					parsed = parseJsonOutput(stdout.tail())
				} catch (error) {
					const detail = trimTail(stderr.trim())
					finish(
						reject,
						new Error(
							`${error instanceof Error ? error.message : String(error)}${code === 0 ? '' : ` (exit code ${String(code)}${signal === null ? '' : `, signal ${String(signal)}`})`}${detail === '' ? '' : `\nstderr: ${detail}`}`
						)
					)
					return
				}
			}
			if (parsed.is_error === true) {
				const reason = typeof parsed.result === 'string' && parsed.result.trim() !== '' ? trimTail(parsed.result.trim()) : 'unknown error'
				finish(reject, new Error(`claude_delegate: Claude Code returned an error (${String(parsed.subtype ?? 'error')}): ${reason}`))
				return
			}
			if (code !== 0 && (typeof parsed.result !== 'string' || parsed.result.trim() === '')) {
				finish(reject, new Error(`claude_delegate: Claude Code exited with code ${String(code)}${stderr.trim() === '' ? '' : `: ${trimTail(stderr.trim())}`}`))
				return
			}
			const answer = typeof parsed.result === 'string' ? parsed.result.trim() : ''
			if (answer === '') {
				finish(reject, new Error('claude_delegate: Claude Code completed without a final answer'))
				return
			}
			finish(resolve, answer)
		})
	})
}

/**
 * Parse a native installer version directory name.
 * @param {string} value
 * @returns {{parts: number[], prerelease: string | undefined} | undefined}
 */
function parseVersion(value) {
	const match = VERSION_NAME.exec(value)
	if (match === null) return undefined
	return {
		parts: [Number(match[1]), Number(match[2]), Number(match[3])],
		prerelease: match[4]
	}
}

/**
 * Compare two native installer version names (semver order; a release beats a
 * prerelease of the same numbers).
 * @param {string} a
 * @param {string} b
 * @returns {number} negative when a < b, positive when a > b, 0 when equal
 */
function compareVersions(a, b) {
	const left = parseVersion(a)
	const right = parseVersion(b)
	if (left === undefined || right === undefined) return a < b ? -1 : a > b ? 1 : 0
	for (let index = 0; index < 3; index += 1) {
		const delta = left.parts[index] - right.parts[index]
		if (delta !== 0) return delta
	}
	if (left.prerelease === right.prerelease) return 0
	if (left.prerelease === undefined) return 1
	if (right.prerelease === undefined) return -1
	return left.prerelease < right.prerelease ? -1 : 1
}

/**
 * Locate the native installer's version store when `command` is its launcher
 * symlink. The launcher is only repointed when it really is that stable
 * launcher (`<prefix>/bin/claude` -> `<prefix>/share/claude/versions/<build>`),
 * so a wrapper or package-manager install is left untouched.
 * @param {any} config
 * @returns {{versionsDir: string, launcher: string | undefined, launcherTarget: string | undefined} | undefined}
 */
function nativeVersionStore(config) {
	const configured = typeof config.versionsDir === 'string' ? config.versionsDir.trim() : ''
	let target
	try {
		const launcher = typeof config.command === 'string' ? config.command : ''
		if (path.isAbsolute(launcher) && lstatSync(launcher).isSymbolicLink()) {
			target = path.resolve(path.dirname(launcher), readlinkSync(launcher))
		}
	} catch {
		// Missing launcher or unreadable symlink: fall back to the configured store.
	}
	if (target !== undefined) {
		const directory = path.dirname(target)
		if (path.basename(directory) === 'versions' && parseVersion(path.basename(target)) !== undefined) {
			return { versionsDir: directory, launcher: config.command, launcherTarget: target }
		}
	}
	if (configured !== '' && existsSync(configured)) {
		return { versionsDir: configured, launcher: undefined, launcherTarget: undefined }
	}
	return undefined
}

/**
 * Newest build in the native version store.
 * @param {string} versionsDir
 * @returns {string | undefined}
 */
function newestInstalledVersion(versionsDir) {
	let entries
	try {
		entries = readdirSync(versionsDir, { withFileTypes: true })
	} catch {
		return undefined
	}
	let newest
	for (const entry of entries) {
		if (!entry.isFile() && !entry.isSymbolicLink()) continue
		if (parseVersion(entry.name) === undefined) continue
		if (newest === undefined || compareVersions(entry.name, newest) > 0) newest = entry.name
	}
	return newest
}

/**
 * Newest installed Claude Code binary when the native store is visible;
 * otherwise the configured command. This keeps every delegate call on the
 * newest build even if something repoints the stable launcher in between.
 * @param {any} config
 * @returns {string}
 */
function resolveLatestCommand(config) {
	if (config.keepLatest === false) return config.command
	try {
		const store = nativeVersionStore(config)
		if (store === undefined) return config.command
		const newest = newestInstalledVersion(store.versionsDir)
		return newest === undefined ? config.command : path.join(store.versionsDir, newest)
	} catch {
		return config.command
	}
}

/**
 * Point the native launcher symlink at the newest installed build.
 * @param {any} config
 * @returns {{changed: boolean, version?: string, skipped?: string}}
 */
function ensureNewestLauncher(config) {
	if (config.keepLatest === false) return { changed: false, skipped: 'disabled' }
	const store = nativeVersionStore(config)
	if (store === undefined) return { changed: false, skipped: 'no-version-store' }
	if (store.launcher === undefined || store.launcherTarget === undefined) {
		return { changed: false, skipped: 'not-a-native-launcher' }
	}
	const newest = newestInstalledVersion(store.versionsDir)
	if (newest === undefined) return { changed: false, skipped: 'no-installed-build' }
	const target = path.join(store.versionsDir, newest)
	if (target === store.launcherTarget) return { changed: false, version: newest }
	const temporary = `${store.launcher}.tmp-${process.pid}-${Date.now()}`
	symlinkSync(target, temporary)
	try {
		renameSync(temporary, store.launcher)
	} catch (error) {
		try {
			unlinkSync(temporary)
		} catch {
			// Best-effort cleanup of the temporary symlink.
		}
		throw error
	}
	return { changed: true, version: newest }
}

/**
 * Normalize the configured update channel.
 * @param {any} config
 * @returns {'latest' | 'stable' | 'off'}
 */
function updateChannel(config) {
	return config.updateChannel === 'stable' ? 'stable' : config.updateChannel === 'off' ? 'off' : 'latest'
}

/**
 * Run `<command> install <channel>` once, bounded by `config.updateTimeoutMs`.
 * @param {any} config
 * @param {string} channel
 * @param {AbortSignal} signal
 * @returns {Promise<any>}
 */
function runInstallLatest(config, channel, signal) {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ skipped: 'aborted' })
			return
		}
		let child
		try {
			child = spawn(config.command, ['install', channel], {
				stdio: ['ignore', 'pipe', 'pipe'],
				detached: true
			})
		} catch (error) {
			resolve({ error })
			return
		}
		let stdout = ''
		let stderr = ''
		let settled = false
		let killTimer
		let timeoutTimer
		const append = (current, chunk) => (current.length < MAX_INSTALL_OUTPUT ? current + chunk.toString('utf8') : current)
		const killTree = (killSignal) => {
			try {
				process.kill(-child.pid, killSignal)
			} catch {
				try {
					child.kill(killSignal)
				} catch {
					// Already gone.
				}
			}
		}
		const finish = (value) => {
			if (settled) return
			settled = true
			clearTimeout(timeoutTimer)
			clearTimeout(killTimer)
			signal.removeEventListener('abort', onAbort)
			resolve(value)
		}
		const onAbort = () => {
			killTree('SIGTERM')
			finish({ skipped: 'aborted' })
		}
		const budget = config.updateTimeoutMs > 0 ? config.updateTimeoutMs : DEFAULT_UPDATE_TIMEOUT_MS
		timeoutTimer = setTimeout(() => {
			killTree('SIGTERM')
			killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS)
			killTimer.unref?.()
			finish({ timedOut: true, stdout, stderr })
		}, Math.max(1_000, budget))
		timeoutTimer.unref?.()
		signal.addEventListener('abort', onAbort, { once: true })
		child.stdout.on('data', (chunk) => {
			stdout = append(stdout, chunk)
		})
		child.stderr.on('data', (chunk) => {
			stderr = append(stderr, chunk)
		})
		child.on('error', (error) => finish({ error }))
		child.on('close', (code, closeSignal) => finish({ code, signal: closeSignal, stdout, stderr }))
	})
}

/**
 * Log through the Cordis logger when the Host provides one.
 * @param {any} ctx
 * @param {'info' | 'warn' | 'error' | 'debug'} level
 * @param {string} message
 */
function logLine(ctx, level, message) {
	const logger = ctx?.logger
	if (logger !== undefined && typeof logger[level] === 'function') {
		logger[level](`claude-delegate: ${message}`)
		return
	}
	const fallback = console[level] ?? console.log
	fallback(`claude-delegate: ${message}`)
}

/**
 * Log through the Host and append the same line to the plugin's status log, so
 * the outcome of an automatic refresh stays inspectable after a restart.
 * @param {any} ctx
 * @param {any} config
 * @param {'info' | 'warn' | 'error' | 'debug'} level
 * @param {string} message
 */
function recordStatus(ctx, config, level, message) {
	logLine(ctx, level, message)
	try {
		const directory = config.tmpDir === '' ? path.join(os.homedir(), '.cache', 'claude-delegate') : config.tmpDir
		mkdirSync(directory, { recursive: true, mode: 0o700 })
		const file = path.join(directory, STATUS_LOG_NAME)
		try {
			if (statSync(file).size > STATUS_LOG_MAX_BYTES) writeFileSync(file, '')
		} catch {
			// First run: there is no log to rotate yet.
		}
		appendFileSync(file, `${new Date().toISOString()} ${level} ${message}\n`, { mode: 0o600 })
	} catch {
		// Status logging must never disturb the refresh itself.
	}
}

/**
 * Warn when the newest installed build predates Fable 5.2 (the user asked for
 * `fable`; older builds resolve that alias to an older model).
 * @param {any} ctx
 * @param {any} config
 */
function warnWhenFableUnavailable(ctx, config) {
	try {
		const store = nativeVersionStore(config)
		if (store === undefined) return
		const newest = newestInstalledVersion(store.versionsDir)
		if (newest !== undefined && compareVersions(newest, MIN_FABLE_52) < 0) {
			logLine(
				ctx,
				'warn',
				`installed Claude Code ${newest} is older than ${MIN_FABLE_52}; the fable alias resolves to an older Fable until a newer build is installed`
			)
		}
	} catch {
		// Diagnostics only.
	}
}

/**
 * Network half of the startup refresh: install the newest build on the
 * configured channel, then select it.
 * @param {any} ctx
 * @param {any} config
 * @param {string} channel
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function refreshLatestOverNetwork(ctx, config, channel, signal) {
	if (signal.aborted) return
	recordStatus(ctx, config, 'debug', `checking Claude Code updates on the ${channel} channel`)
	let result
	try {
		result = await runInstallLatest(config, channel, signal)
	} catch (error) {
		result = { error }
	}
	if (signal.aborted || result?.skipped === 'aborted') return
	if (result?.error !== undefined) {
		recordStatus(ctx, config, 'warn', `could not refresh Claude Code: ${result.error instanceof Error ? result.error.message : String(result.error)}`)
		return
	}
	if (result?.timedOut === true) {
		recordStatus(ctx, config, 'warn', `Claude Code update check timed out after ${config.updateTimeoutMs} ms`)
		return
	}
	if (result?.code !== 0) {
		const detail = String(result?.stderr ?? '').trim().split('\n').slice(-3).join(' ')
		recordStatus(ctx, config, 'warn', `Claude Code update check exited with ${String(result?.code)}${detail === '' ? '' : `: ${detail}`}`)
		return
	}
	try {
		const repaired = ensureNewestLauncher(config)
		warnWhenFableUnavailable(ctx, config)
		if (repaired.changed === true) {
			recordStatus(ctx, config, 'info', `Claude Code ${repaired.version} installed and selected`)
			return
		}
		const store = nativeVersionStore(config)
		const newest = store === undefined ? undefined : newestInstalledVersion(store.versionsDir)
		recordStatus(ctx, config, 'info', `Claude Code is current on the ${channel} channel${newest === undefined ? '' : ` (${newest})`}`)
	} catch (error) {
		recordStatus(ctx, config, 'warn', `could not select the newest Claude Code build: ${error instanceof Error ? error.message : String(error)}`)
	}
}

/**
 * Repair the launcher locally, then refresh the CLI over the network in the
 * background and repair again once the install settles. Nothing here may fail
 * plugin activation: a machine that is offline still starts and delegates with
 * the newest build already on disk.
 * @param {any} ctx
 * @param {any} config
 * @param {AbortSignal} signal
 * @returns {NodeJS.Timeout | undefined}
 */
function refreshLatest(ctx, config, signal) {
	if (config.keepLatest === false) return undefined
	try {
		const repaired = ensureNewestLauncher(config)
		if (repaired.changed === true) {
			recordStatus(ctx, config, 'info', `selected Claude Code ${repaired.version} from the newest installed build`)
		}
	} catch (error) {
		recordStatus(ctx, config, 'warn', `could not repoint the Claude Code launcher: ${error instanceof Error ? error.message : String(error)}`)
	}
	warnWhenFableUnavailable(ctx, config)
	const channel = updateChannel(config)
	if (channel === 'off') return undefined
	return setTimeout(() => {
		void refreshLatestOverNetwork(ctx, config, channel, signal)
	}, STARTUP_DELAY_MS)
}

/**
 * Register `claude_delegate` on `ctx.tools`.
 * @param {any} ctx
 * @param {any} config
 */
export function apply(ctx, config) {
	ctx.tools.register(
		defineTool({
			name: 'claude_delegate',
			description: [
				'Delegate one self-contained task to a fresh, unattended Claude Code session (Anthropic subscription) in the session workspace.',
				'Pick the model and reasoning effort per call.',
				'It does not see this conversation and returns only its final answer.',
				'By default it runs with permissions bypassed; pass `readOnly: true` to run in plan mode instead (no edits, no commands that need approval).',
				'Use it for independent implementation, review, or research work; include everything it needs in `task`.'
			].join(' '),
			parameters: {
				task: {
					type: 'string',
					required: true,
					description: 'The complete, self-contained task, including context, acceptance criteria, and any paths it must read or edit.'
				},
				model: {
					type: 'string',
					enum: [...MODELS],
					description: 'Claude model alias: opus (default), sonnet, haiku, or fable. Each resolves to the latest build installed by the host CLI. fable is the most capable and most expensive model: reserve it for the hardest, longest tasks; depending on the plan it bills usage credits.'
				},
				effort: {
					type: 'string',
					enum: [...EFFORTS],
					description: 'Reasoning effort: low, medium, high (default), xhigh, or max. The model may clamp a level it does not support.'
				},
				cwd: {
					type: 'string',
					description: 'Absolute working directory for the child. Omit to use this session workspace.'
				},
				readOnly: {
					type: 'boolean',
					description: 'Run the child in read-only mode (Claude Code plan mode): no file edits and no commands that need approval. Default false (permissions bypassed).'
				}
			},
			output: {
				schema: { type: 'string' },
				render: (_args, value) => [{ type: 'text', text: value }]
			},
			...(config.timeoutMs > 0 ? { timeoutMs: config.timeoutMs } : {}),
			isConcurrencySafe: false,
			presentCall: (args) => ({
				card: 'generic',
				title: `Claude delegate · ${args.model ?? config.model} · ${args.effort ?? config.effort}`,
				kind: 'other',
				rawInput: typeof args.task === 'string' ? args.task : ''
			}),
			async execute(args, exec) {
				const model = args.model ?? config.model
				const effort = args.effort ?? config.effort
				let cwd = args.cwd
				if (cwd === undefined) {
					try {
						cwd = exec.agent === undefined ? process.cwd() : await ctx.workingDirectory.ensure(exec.agent, exec.signal)
					} catch {
						cwd = process.cwd()
					}
				}
				if (typeof cwd !== 'string' || cwd === '') throw new Error('claude_delegate: a working directory is required')
				const env = childEnvironment(config)
				// `readOnly` switches the child to plan mode (no edits); the
				// default keeps the unattended bypass the tool has always used.
				const permissionArgs = args.readOnly === true
					? ['--permission-mode', 'plan']
					: ['--dangerously-skip-permissions']
				const claudeArgs = [
					'-p',
					args.task,
					'--model',
					model,
					'--effort',
					effort,
					...permissionArgs,
					'--output-format',
					'stream-json',
					'--verbose',
					'--no-session-persistence'
				]
				return runClaude({ command: resolveLatestCommand(config), args: claudeArgs, cwd, env, signal: exec.signal })
			}
		})
	)

	// Keep the host CLI current on every DSH start: repair the launcher from the
	// builds already on disk immediately, then refresh over the network in the
	// background and repair again. `keepLatest: false` opts out entirely.
	ctx.effect(() => {
		const controller = new AbortController()
		const timer = refreshLatest(ctx, config, controller.signal)
		return () => {
			if (timer !== undefined) clearTimeout(timer)
			controller.abort()
		}
	}, 'claude-delegate: keep the host Claude Code build current')
}
