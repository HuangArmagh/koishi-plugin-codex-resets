import { createHash } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import type { Clock, Target } from './types'

export const clock: Clock = {
  now: () => Date.now(),
  sleep: async (ms, signal) => { await setTimeout(ms, undefined, { signal }) },
}

export function hash(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

export function targetKey(target: Omit<Target, 'id'>): string {
  const { platform, selfId, type, targetId, guildId } = target
  // Telegram topic IDs are local to a group; retain existing IDs for all other targets.
  return hash(platform === 'telegram' && type === 'channel' && guildId && guildId !== targetId
    ? [platform, selfId, type, guildId, targetId]
    : [platform, selfId, type, targetId])
}

export class Serial {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(callback: () => Promise<T>): Promise<T> {
    const task = this.tail.then(callback)
    this.tail = task.catch(() => undefined)
    return task
  }
}

function errorField(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined
  try { return (value as Record<string, unknown>)[key] } catch { return undefined }
}

function diagnostic(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''
  // Read selected diagnostics only, never serialize request config, headers or stacks.
  return String(value).slice(0, 8192)
    .replace(/(?:https?|wss?):\/\/[^\s<>"']+/gi, '[URL]')
    .replace(/\b(Bearer|Basic|QQBot)\s+[^\s,;"']+/gi, '$1 [REDACTED]')
    .replace(/\b(authorization|access[_-]?token|refresh[_-]?token|token|client[_-]?secret|secret|password|api[_-]?key)["']?\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1=[REDACTED]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
    .slice(0, 400)
}

function errorChain(error: unknown): unknown[] {
  const seen = new Set<object>()
  const chain: unknown[] = []
  let remaining = 12
  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || remaining-- <= 0) return
    if (!value || typeof value !== 'object') { chain.push(value); return }
    if (seen.has(value)) return
    seen.add(value)
    chain.push(value)
    // Satori uses its own AggregateError class; do not rely on instanceof.
    const errors = errorField(value, 'errors')
    if (Array.isArray(errors)) for (const child of errors.slice(0, 12)) visit(child, depth + 1)
    const cause = errorField(value, 'cause')
    if (cause !== undefined) visit(cause, depth + 1)
  }
  visit(error, 0)
  return chain
}

function errorBody(value: unknown): unknown {
  const data = errorField(errorField(value, 'response'), 'data')
  if (typeof data !== 'string') return data
  if (data.length <= 8192) {
    try { return JSON.parse(data) } catch { /* Ignore non-JSON response bodies. */ }
  }
}

export function hasResponseCode(error: unknown, code: number): boolean {
  return errorChain(error).some(value => {
    const actual = errorField(errorBody(value), 'code')
    return actual === code || actual === String(code)
  })
}

export function errorText(error: unknown): string {
  const parts: string[] = []
  for (const value of errorChain(error)) {
    if (!value || typeof value !== 'object') {
      const reason = diagnostic(value)
      if (reason) parts.push(reason)
      continue
    }
    const response = errorField(value, 'response')
    const status = errorField(response, 'status') ?? errorField(value, 'status')
    const data = errorBody(value)
    const details: string[] = []
    if ((typeof status === 'number' || typeof status === 'string') && /^[1-5]\d\d$/.test(String(status))) details.push(`HTTP ${status}`)
    const code = diagnostic(errorField(data, 'code') ?? errorField(data, 'error_code') ?? errorField(value, 'code'))
    if (code) details.push(`code=${code}`)
    for (const reason of [errorField(data, 'message'), errorField(data, 'description'), errorField(value, 'message')]) {
      const message = diagnostic(reason)
      if (message && !details.includes(message)) details.push(message)
    }
    if (details.length) parts.push(details.join('；'))
  }
  const result = [...new Set(parts)].join(' | ') || '未知错误（未提供错误详情）'
  return result.length > 2000 ? result.slice(0, 1999) + '…' : result
}
