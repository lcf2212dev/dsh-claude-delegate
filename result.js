/**
 * Result selection for one `claude -p` run.
 *
 * Claude Code's `--output-format stream-json` prints one JSON event per line.
 * A run normally ends with one `result` event, but a background task that
 * finishes after the agent already answered adds an extra turn: the CLI asks
 * the model to react to the task notification and then prints a *second*
 * `result` event whose text is only an acknowledgement ("the background task
 * finished..."). Returning that event — as `--output-format json` did, because
 * it prints the last result — replaced the worker's real report with a short
 * notice response in two delegations (Orvalho and Lua, 2026-11-11).
 *
 * The two helpers here keep the memory bounded while the child runs and pick
 * the event that carries the real answer of the task: the last `result` event
 * that is not a reaction to a background-task notification.
 *
 * @module result
 */

/** Cap for the raw stdout tail kept for error diagnostics. */
const MAX_STDOUT_TAIL = 64 * 1024

/** A single JSONL line above this size is dropped: a result event is small. */
const MAX_EVENT_LINE_BYTES = 4 * 1024 * 1024

/**
 * Whether a `result` event is the CLI reacting to a background-task notification
 * instead of answering the task itself.
 *
 * @param {any} event parsed JSONL event.
 * @returns {boolean}
 */
export function isTaskNotificationResult(event) {
	if (event === null || typeof event !== 'object') return false
	const origin = event.origin
	return origin !== null && typeof origin === 'object' && origin.kind === 'task-notification'
}

/**
 * The `result` event that carries the answer of one run, or `null` when the
 * stream carried none. The last result wins unless it is a background-task
 * notification reaction; in that case the last earlier real result is used.
 * When every result is a notification reaction (the model only answered
 * notifications), the last event is returned as a fallback.
 *
 * @param {any[]} events parsed `result` events, in stream order.
 * @returns {any | null}
 */
export function selectResultEvent(events) {
	if (!Array.isArray(events) || events.length === 0) return null
	for (let index = events.length - 1; index >= 0; index -= 1) {
		const event = events[index]
		if (!isTaskNotificationResult(event)) return event === undefined ? null : event
	}
	return events[events.length - 1]
}

/**
 * Incremental collector for the `result` events of a stream-json run.
 *
 * `feed()` accepts text chunks of any shape (a JSON line may be split across
 * chunks), keeps only the `result` events and a bounded raw tail, so a long
 * verbose transcript never has to be held in memory. `finish()` flushes a
 * final line that arrived without its newline.
 *
 * @returns {{ feed: (text: string) => void, finish: () => void, resultEvents: () => any[], tail: () => string }}
 */
export function createResultCollector() {
	/** @type {any[]} */
	const events = []
	let pending = ''
	let tail = ''
	let droppedLine = false

	/**
	 * @param {string} line one JSONL line (without the newline).
	 * @returns {void}
	 */
	function pushLine(line) {
		const trimmed = line.trim()
		if (trimmed === '' || !trimmed.startsWith('{')) return
		let event
		try {
			event = JSON.parse(trimmed)
		} catch {
			return
		}
		if (event !== null && typeof event === 'object' && event.type === 'result') events.push(event)
	}

	return {
		feed(text) {
			if (typeof text !== 'string' || text === '') return
			tail = (tail + text).slice(-MAX_STDOUT_TAIL)
			if (droppedLine) return
			pending += text
			let index = pending.indexOf('\n')
			while (index >= 0) {
				const line = pending.slice(0, index)
				pending = pending.slice(index + 1)
				pushLine(line)
				index = pending.indexOf('\n')
			}
			if (pending.length > MAX_EVENT_LINE_BYTES) {
				pending = ''
				droppedLine = true
			}
		},
		finish() {
			const line = pending
			pending = ''
			if (!droppedLine) pushLine(line)
		},
		resultEvents() {
			return events
		},
		tail() {
			return tail
		},
	}
}
