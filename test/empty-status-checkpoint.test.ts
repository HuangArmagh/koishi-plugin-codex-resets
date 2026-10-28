import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { CodexApi } from '../src/api'
import { Monitor, resetKey } from '../src/monitor'
import type { Reset, ResetType, ScheduledReset, Subscription } from '../src/types'
import { makeClock, NOW, reset, scheduled, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

async function setup(type: 'channel' | 'private' = 'private', resetType: ResetType = 'regular') {
  const app = new App()
  app.plugin(Memory)
  app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx) } })
  await app.start()
  const clock = makeClock(), signal = new AbortController().signal
  const event = (id: string, offset: number) => reset({ id, reset_type: resetType,
    announced_at: new Date(NOW + offset).toISOString(), source: { type: 'x_post' } })
  const previous = event('100', -3600_000), middle = event('200', 60_000), newest = event('300', 120_000)
  const data = { latest: previous as Reset | null, rows: [previous], announcement: null as ScheduledReset | null,
    failHistoryPage: -1, pageSize: 100 }
  const requests: { path: string; from: number; at: number }[] = []
  const transport: ConstructorParameters<typeof CodexApi>[0] = async url => {
    const parsed = new URL(url), from = Date.parse(parsed.searchParams.get('from') ?? '')
    requests.push({ path: parsed.pathname, from, at: clock.now() })
    if (parsed.pathname.endsWith('/status')) return { status: 200, headers: new Headers(), body: status({
      latest_reset: data.latest, scheduled_reset: data.announcement,
    }) }
    const offset = Number(parsed.searchParams.get('cursor') ?? 0)
    if (offset === data.failHistoryPage) {
      data.failHistoryPage = -1
      return { status: 503, headers: new Headers(), body: { detail: 'Reset data is temporarily unavailable.' } }
    }
    const rows = data.rows.filter(row => Date.parse(row.announced_at) >= from)
      .sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at))
    const end = offset + data.pageSize
    return { status: 200, headers: new Headers(), body: {
      data: rows.slice(offset, end), pagination: { has_more: end < rows.length, next_cursor: end < rows.length ? String(end) : null },
    } }
  }
  const destination = target('destination', type, 'bot', 'qq'), send = vi.fn(async (_target: Subscription, _content: string) => {})
  const options = { clock, signal, sendDelayMs: 1000, report: vi.fn() }
  const reload = () => {
    const store = new KoishiStore(app), api = new CodexApi(transport, { clock, signal, cacheMs: 300_000, stateStore: store })
    return { store, api, monitor: new Monitor(store, api, send, options) }
  }
  const runtime = reload()
  const deliveries = () => app.database.get('codex_reset_delivery', { subscriptionId: destination.id, kind: 'reset' })
  return { ...runtime, app, clock, data, requests, destination, send, options, reload, previous, middle, newest, event, deliveries,
    history: () => requests.filter(row => row.path.endsWith('/resets')),
  }
}

describe('empty latest status preserves execution catch-up progress', () => {
  it.each([
    ['channel', 'regular', false], ['private', 'regular', false], ['channel', 'banked', false], ['private', 'banked', false],
    ['channel', 'regular', true], ['private', 'regular', true], ['channel', 'banked', true], ['private', 'banked', true],
  ] as const)('recovers every missed reset for %s %s; reload=%s', async (type, resetType, reload) => {
    const c = await setup(type, resetType)
    try {
      await c.monitor.subscribe(c.destination)
      await c.monitor.poll()
      const checkpoint = await c.store.checkpoint()
      c.data.latest = null
      c.data.rows = [c.previous, c.middle, c.newest]
      for (let index = 0; index < 2; index++) {
        c.clock.advance(300_000)
        await c.monitor.poll()
        expect(await c.store.checkpoint()).toEqual(checkpoint)
      }
      expect(c.history()).toHaveLength(1) // No extra history requests for stable empty snapshots.
      expect(c.send).not.toHaveBeenCalled()
      const runtime = reload ? c.reload() : c
      c.clock.advance(300_000)
      c.data.latest = c.newest
      await runtime.monitor.poll()
      expect(c.history().at(-1)?.from).toBe(NOW)
      expect((await c.deliveries()).map(row => row.eventKey)).toEqual([resetKey(c.middle), resetKey(c.newest)])
      expect(c.send).toHaveBeenCalledTimes(2)
      expect(await runtime.store.checkpoint()).toMatchObject({ latestResetKey: resetKey(c.newest) })
      c.clock.advance(300_000)
      c.data.latest = { ...c.newest, id: 'observed-300', source: { type: 'observed' } }
      await c.reload().monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(2)
      expect(c.history()).toHaveLength(2)
      expect(c.requests.slice(1).every((row, i) => row.at - c.requests[i]!.at >= 5000)).toBe(true)
    } finally { await c.app.stop() }
  })

  it('recovers a persisted empty checkpoint without using its later checkedAt as the history boundary', async () => {
    const c = await setup()
    try {
      await c.monitor.subscribe(c.destination)
      await c.monitor.poll()
      c.clock.advance(300_000)
      await c.store.saveCheckpoint({ latestResetKey: null, latestResetAt: null, checkedAt: c.clock.now() })
      c.data.latest = c.newest
      c.data.rows = [c.previous, c.middle, c.newest]
      c.clock.advance(300_000)
      await c.reload().monitor.poll()
      expect(c.history().at(-1)?.from).toBe(NOW)
      expect((await c.deliveries()).map(row => row.eventKey)).toEqual([resetKey(c.middle), resetKey(c.newest)])
      expect(c.send).toHaveBeenCalledTimes(2)
    } finally { await c.app.stop() }
  })

  it('catches up after an initially empty status, even when the recovering latest has an old announcement time', async () => {
    const c = await setup()
    try {
      c.data.latest = null
      c.data.rows = []
      await c.monitor.subscribe(c.destination)
      await c.monitor.poll()
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(true)
      expect(await c.store.checkpoint()).toBeNull()
      c.clock.advance(300_000)
      await c.monitor.poll()
      expect(c.history()).toHaveLength(1)
      const observed = { ...c.middle, id: 'observed-200', source: { type: 'observed' as const } }
      c.data.latest = { ...c.middle, announced_at: c.previous.announced_at }
      c.data.rows = [observed]
      c.clock.advance(300_000)
      await c.reload().monitor.poll()
      expect(c.history().at(-1)?.from).toBe(NOW)
      expect(await c.store.executionLinks()).toContainEqual({ observedKey: resetKey(observed), originalKey: resetKey(c.middle) })
      expect(await c.deliveries()).toHaveLength(1)
      c.data.latest = observed
      c.clock.advance(300_000)
      await c.reload().monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { await c.app.stop() }
  })

  it('keeps the last valid checkpoint across failed recovery pagination, cooldown and reload', async () => {
    const c = await setup()
    try {
      await c.monitor.subscribe(c.destination)
      await c.monitor.poll()
      const checkpoint = await c.store.checkpoint()
      c.data.latest = null
      c.clock.advance(300_000)
      await c.monitor.poll()
      c.data.latest = c.newest
      c.data.rows = [c.previous, c.middle, c.event('250', 90_000), c.newest]
      c.data.pageSize = 1
      c.data.failHistoryPage = 1
      c.clock.advance(300_000)
      await c.monitor.poll()
      expect(await c.store.checkpoint()).toEqual(checkpoint)
      expect(c.options.report).toHaveBeenCalledTimes(1)
      expect(c.api.retryAt).toBe(c.requests.at(-1)!.at + 300_000)
      const runtime = c.reload(), requestCount = c.requests.length
      await expect(runtime.monitor.poll()).rejects.toThrow('退避')
      expect(c.requests).toHaveLength(requestCount)
      c.clock.advance(300_000)
      await runtime.monitor.poll()
      expect(new Set((await c.deliveries()).map(row => row.eventKey))).toEqual(new Set([
        resetKey(c.middle), 'reset:regular:250', resetKey(c.newest),
      ]))
      expect(c.send).toHaveBeenCalledTimes(3)
      expect(c.history().every(row => row.from === NOW)).toBe(true)
      expect(await c.store.checkpoint()).toMatchObject({ latestResetKey: resetKey(c.newest) })
    } finally { await c.app.stop() }
  })

  it('allows announcements while latest is empty and still catches their execution from history', async () => {
    const c = await setup()
    try {
      await c.monitor.subscribe(c.destination)
      await c.monitor.poll()
      const checkpoint = await c.store.checkpoint()
      c.data.latest = null
      c.data.announcement = scheduled({ ...c.middle })
      c.clock.advance(300_000)
      await c.monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(1)
      expect(c.send.mock.calls[0]![1]).toContain('重置预告')
      expect(await c.store.checkpoint()).toEqual(checkpoint)
      c.data.announcement = null
      c.data.rows = [c.previous, c.middle, c.newest]
      c.clock.advance(300_000)
      await c.reload().monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(3)
      expect((await c.store.subscription(c.destination.id))?.pendingResets).toEqual([])
      expect(await c.store.checkpoint()).toEqual(checkpoint)
      c.data.latest = c.newest
      c.clock.advance(300_000)
      await c.reload().monitor.poll()
      expect(c.send).toHaveBeenCalledTimes(3)
    } finally { await c.app.stop() }
  })
})
