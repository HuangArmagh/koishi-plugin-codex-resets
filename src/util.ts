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

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
