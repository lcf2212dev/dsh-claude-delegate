#!/usr/bin/env node
/**
 * Result selection of one claude_delegate run (result.js).
 *
 * Covers the regression that lost two worker reports on 2026-11-11: a
 * background task that finishes after the agent answered makes the Claude Code
 * CLI append a `task-notification` turn and a second `result` event; the
 * wrapper must return the answer of the task, not the notification response.
 *
 * The fixture is a trimmed capture of a real `claude -p --output-format
 * stream-json --verbose` run (background `sleep`, real report `REPORT_MARKER_123`,
 * then the notification acknowledgement as the last result).
 *
 * Plain `node test/result.test.mjs`; only Node built-ins are used.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createResultCollector, isTaskNotificationResult, selectResultEvent } from '../result.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(HERE, 'fixtures', 'background-notification.stream.jsonl')
const STREAM = fs.readFileSync(FIXTURE, 'utf8')
const REAL_REPORT = 'REPORT_MARKER_123'
const NOTIFICATION_REPLY = 'O comando em background terminou com sucesso (exit code 0). Não há mais nada pendente.'

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`ok - ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.error(`not ok - ${name}`)
    console.error(error)
  }
}

/**
 * Feed one stream in fixed-size chunks, imitating split JSON lines.
 *
 * @param {string} text stream text.
 * @param {number} chunkSize characters per feed.
 * @returns {{ events: any[], tail: string }}
 */
function collect(text, chunkSize = 0) {
  const collector = createResultCollector()
  if (chunkSize <= 0) {
    collector.feed(text)
  } else {
    for (let index = 0; index < text.length; index += chunkSize) {
      collector.feed(text.slice(index, index + chunkSize))
    }
  }
  collector.finish()
  return { events: collector.resultEvents(), tail: collector.tail() }
}

test('a whole-stream feed returns the task report, not the notification reply', () => {
  const { events, tail } = collect(STREAM)
  assert.equal(events.length, 2, 'both result events were collected')
  assert.equal(selectResultEvent(events).result, REAL_REPORT)
  assert.ok(tail.includes(NOTIFICATION_REPLY), 'the raw tail keeps the last line for diagnostics')
})

test('the selection survives JSON lines split across feed chunks', () => {
  for (const chunkSize of [3, 7, 16, 64, 1024]) {
    const { events } = collect(STREAM, chunkSize)
    assert.equal(events.length, 2, `two result events with ${chunkSize}-char chunks`)
    assert.equal(selectResultEvent(events).result, REAL_REPORT, `report with ${chunkSize}-char chunks`)
  }
})

test('a run without notifications returns its only result', () => {
  const lines = STREAM.trim().split('\n')
  const withoutNotification = lines.filter((line) => {
    const event = JSON.parse(line)
    return event.type !== 'result' || isTaskNotificationResult(event) !== true
  })
  const text = `${withoutNotification.join('\n')}\n`
  const selected = selectResultEvent(collect(text).events)
  assert.equal(selected.result, REAL_REPORT)
})

test('a notification-only stream falls back to its last result', () => {
  const lines = STREAM.trim().split('\n').map((line) => JSON.parse(line))
  const onlyNotification = lines.filter((event) => event.type === 'result' && isTaskNotificationResult(event))
  assert.equal(onlyNotification.length, 1)
  const selected = selectResultEvent(onlyNotification)
  assert.equal(selected.result, NOTIFICATION_REPLY)
  assert.equal(selectResultEvent([]), null)
  assert.equal(selectResultEvent(null), null)
})

test('isTaskNotificationResult reads the result origin only', () => {
  assert.equal(isTaskNotificationResult({ type: 'result', origin: { kind: 'task-notification' } }), true)
  assert.equal(isTaskNotificationResult({ type: 'result', origin: { kind: 'user' } }), false)
  assert.equal(isTaskNotificationResult({ type: 'result' }), false)
  assert.equal(isTaskNotificationResult({ type: 'result', origin: 'task-notification' }), false)
  assert.equal(isTaskNotificationResult(null), false)
})

test('malformed, blank and non-JSON lines are ignored', () => {
  const noisy = [
    'launcher banner',
    '',
    '{not json}',
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'result', result: REAL_REPORT }),
    '   ',
    JSON.stringify({ type: 'result', result: 'later report' }),
  ].join('\n')
  const { events } = collect(noisy)
  assert.equal(events.length, 2)
  assert.equal(selectResultEvent(events).result, 'later report')
})

test('a final line without a trailing newline is flushed', () => {
  const last = JSON.stringify({ type: 'result', result: REAL_REPORT })
  const { events } = collect(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n${last}`)
  assert.equal(events.length, 1)
  assert.equal(selectResultEvent(events).result, REAL_REPORT)
})

if (failures.length > 0) {
  console.error(`\nresult: ${passed} passed, ${failures.length} failed`)
  process.exit(1)
}
console.log(`\nresult: ${passed} tests passed`)
