/**
 * Claude delegate — one model-facing tool that runs a fresh, unattended
 * Claude Code session through the host `claude` CLI.
 *
 * Why the CLI instead of `@anthropic-ai/claude-agent-sdk`: the host launcher
 * updates daily, so the delegate never pins an SDK build. `command` points at
 * the stable launcher symlink (e.g. `~/.local/bin/claude`), not the versioned
 * binary and not a wrapper that injects flags of its own.
 *
 * One call = one `claude -p` process: no continuation, no resume, no shared
 * context with the caller. The tool blocks until the child exits and returns
 * only the final answer text.
 *
 * @module @local/dsh-claude-delegate
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'claude-delegate'
export const inject = ['tools', 'workingDirectory']

/** Model aliases accepted by the Claude Code CLI; each resolves to the latest build. */
const MODELS = ['opus', 'sonnet', 'haiku']
/** Effort levels accepted by `--effort` (newer CLI builds may clamp silently). */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
/** Ambient credentials removed so the child uses the native subscription login. */
const CREDENTIAL_ENV = [
	'ANTHROPIC_API_KEY',
	'ANTHROPIC_AUTH_TOKEN',
	'CLAUDE_CODE_OAUTH_TOKEN',
	'CLAUDE_CODE_API_KEY'
]
/** Bytes kept per stream before the tail is dropped. */
const MAX_STREAM_BYTES = 8 * 1024 * 1024
/** Grace between SIGTERM and SIGKILL when a run is cancelled. */
const KILL_GRACE_MS = 3_000

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
	isolateCredentials: z.boolean().default(true)
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
	let stdout = ''
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
		child.stdout.on('data', (chunk) => {
			stdout = append(stdout, chunk)
		})
		child.stderr.on('data', (chunk) => {
			stderr = append(stderr, chunk)
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
			let parsed
			try {
				parsed = parseJsonOutput(stdout)
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
					description: 'Claude model alias: opus (default), sonnet, or haiku. Each resolves to the latest build installed by the host CLI.'
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
					'json',
					'--no-session-persistence'
				]
				return runClaude({ command: config.command, args: claudeArgs, cwd, env, signal: exec.signal })
			}
		})
	)
}
