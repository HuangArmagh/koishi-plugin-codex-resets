import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApi } from '../src/api'
import { Monitor, resetKey } from '../src/monitor'
import type { Reset, ResetType, ScheduledReset, Subscription } from '../src/types'
import { makeClock, NOW, reset, scheduled, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

afterEach(() => vi.restoreAllMocks())

async function setup(type: 'channel' | 'private' = 'private', reset_type: ResetType = 'regular') {
  const app = new App()
  app.plugin(Memory)
  app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx) } })
  await app.start()
  const clock = makeClock(), signal = new AbortController().signal
  const previous = reset({ id: '100', announced_at: new Date(NOW - 7200_000).toISOString() })
  const older = reset({ id: '200', reset_type, announced_at: new Date(NOW - 60_000).toISOString(), source: { type: 'x_post' } })
  const observed = reset({ ...older, id: 'observed-200', announced_at: new Date(NOW + 60_000).toISOString(), source: { type: 'observed' } })
  const newest = reset({ id: '300', announced_at: new Date(NOW + 90_000).toISOString() })
  const data = { latest: previous as Reset | null, rows: [] as Reset[], announcement: null as ScheduledReset | null,
    failStatus: false, failHistoryPage: -1, pageSize: 100 }
  const requests: { path: string; at: number; from: number }[] = []
  const transport: ConstructorParameters<typeof CodexApi>[0] = async url => {
    const parsed = new URL(url), from = Date.parse(parsed.searchParams.get('from') ?? '')
    requests.push({ path: parsed.pathname, at: clock.now(), from })
    const isStatus = parsed.pathname.endsWith('/status')
    const offset = Number(parsed.searchParams.get('cursor') ?? 0)
    if (isStatus && data.failStatus || !isStatus && offset === data.failHistoryPage) {
      data.failStatus = false
      data.failHistoryPage = -1
      return { status: 503, headers: new Headers(), body: { detail: 'Reset data is temporarily unavailable.' } }
    }
    if (isStatus) return { status: 200, headers: new Headers(), body: status({ latest_reset: data.latest, scheduled_reset: data.announcement }) }
    const rows = data.rows.filter(row => Date.parse(row.announced_at) >= from)
      .sort((a, b) => Date.parse(a.announced_at) - Date.parse(b.announced_at))
    const end = offset + data.pageSize
    return { status: 200, headers: new Headers(), body: {
      data: rows.slice(offset, end), pagination: { has_more: end < rows.length, next_cursor: end < rows.length ? String(end) : null },
    } }
  }
  const send = vi.fn(async (_target: Subscription, _content: string) => {})
  const options = { clock, signal, sendDelayMs: 1000, report: vi.fn() }
  const reload = () => {
    const store = new KoishiStore(app)
    const api = new CodexApi(transport, { clock, signal, cacheMs: 300_000, stateStore: store })
    return { store, api, monitor: new Monitor(store, api, send, options) }
  }
  const destination = target('new', type, 'bot-a', 'qq'), existing = target('existing', 'channel', 'bot-a', 'qq')
  return { ...reload(), app, clock, signal, options, send, data, requests, reload, destination, existing,
    previous, older, observed, newest,
    messages: () => send.mock.calls.filter(([target]) => target.id === destination.id),
    history: () => requests.filter(row => row.path.endsWith('/resets')),
  }
}

describe('initialization covers subscription history before committing exclusions', () => {
  it.each([
    ['channel', 'regular', false], ['private', 'regular', false], ['channel', 'banked', false], ['private', 'banked', false],
    ['channel', 'regular', true], ['private', 'regular', true], ['channel', 'banked', true], ['private', 'banked', true],
  ] as const)('recovers a first status failure for %s %s with older latest time; reload=%s', async (type, resetType, reload) => {
    const c = await setup(type, resetType)
    try {
      await c.monitor.subscribe(c.destination)
      c.data.failStatus = true
      await expect(c.monitor.poll()).rejects.toThrow('temporarily unavailable')
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(false)
      c.clock.advance(300_000)
      c.data.latest = c.older
      c.data.rows = [c.older, c.observed]
      const runtime = reload ? c.reload() : c
      await runtime.monitor.poll()
      const sub = (await runtime.store.subscription(c.destination.id))!
      expect(sub).toMatchObject({ baselined: true, baselineResetKey: '' })
      expect(c.history()).toHaveLength(1)
      expect(c.history()[0]?.from).toBe(sub.subscribedAt)
      const deliveries = await runtime.store.executionDeliveries(sub.id, sub.generation, [resetKey(c.older), resetKey(c.observed)])
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.payload?.reset).toEqual(c.observed)
      expect(c.messages()).toHaveLength(1)
      c.data.latest = c.observed
      c.clock.advance(300_000)
      await c.reload().monitor.poll()
      expect(c.messages()).toHaveLength(1)
      expect(c.history()).toHaveLength(1)
    } finally { await c.app.stop() }
  })

  it.each(['known', 'absent'] as const)('checks history even when the recovering status is %s', async latest => {
    const c = await setup()
    try {
      await c.store.saveExecutions([resetKey(c.previous)])
      await c.monitor.subscribe(c.destination)
      c.data.failStatus = true
      await expect(c.monitor.poll()).rejects.toThrow()
      c.clock.advance(300_000)
      c.data.latest = latest === 'known' ? c.previous : null
      c.data.rows = [c.observed]
      await c.reload().monitor.poll()
      expect(c.messages()).toHaveLength(1)
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(true)
    } finally { await c.app.stop() }
  })

  it.each([
    ['channel', 'regular'], ['private', 'regular'], ['channel', 'banked'], ['private', 'banked'],
  ] as const)('persists initial pre-subscription exclusions across rollback, alias changes and reload for %s %s', async (type, resetType) => {
    const c = await setup(type, resetType)
    try {
      c.clock.advance(-3600_000)
      await c.monitor.subscribe(c.existing)
      await c.monitor.poll()
      c.clock.advance(NOW - c.clock.now())
      await c.monitor.subscribe(c.destination)
      c.clock.advance(120_000)
      c.data.latest = c.newest
      c.data.rows = [c.older, c.newest]
      await c.monitor.poll()
      expect(c.messages()).toHaveLength(1)
      const initialized = (await c.store.subscription(c.destination.id))!
      expect(initialized.baselineExecutionKeys).toContain(resetKey(c.older))
      for (const latest of [c.older, { ...c.observed, announced_at: c.older.announced_at }]) {
        c.data.latest = latest
        c.clock.advance(300_000)
        await c.reload().monitor.poll()
      }
      expect(c.messages()).toHaveLength(1)
      expect(await c.store.executionDeliveries(initialized.id, initialized.generation, [resetKey(c.older), resetKey(c.observed)])).toEqual([])
      await c.monitor.subscribe(c.destination, 'en-US')
      expect((await c.store.subscription(c.destination.id))?.baselineExecutionKeys).toEqual(initialized.baselineExecutionKeys)
    } finally { await c.app.stop() }
  })

  it('does not exclude an older original before a later page reveals its eligible observed record', async () => {
    const c = await setup()
    try {
      c.clock.advance(-3600_000)
      await c.monitor.subscribe(c.existing)
      await c.monitor.poll()
      c.clock.advance(NOW - c.clock.now())
      await c.monitor.subscribe(c.destination)
      c.clock.advance(120_000)
      c.data.latest = c.newest
      c.data.rows = [c.older, c.observed, c.newest]
      c.data.pageSize = 1
      c.data.failHistoryPage = 1
      await c.monitor.poll()
      const incomplete = (await c.store.subscription(c.destination.id))!
      expect(incomplete.baselined).toBe(false)
      expect(incomplete.baselineExecutionKeys).not.toContain(resetKey(c.older))
      c.clock.advance(300_000)
      await c.reload().monitor.poll()
      expect((await c.store.subscription(c.destination.id))?.baselineExecutionKeys).not.toContain(resetKey(c.older))
      const deliveries = await c.store.executionDeliveries(incomplete.id, incomplete.generation, [resetKey(c.older), resetKey(c.observed)])
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.payload?.reset).toEqual(c.observed)
      expect(c.messages()).toHaveLength(2)
    } finally { await c.app.stop() }
  })

  it('retains a tracked announcement with an older timestamp when initial history fails and resumes', async () => {
    const c = await setup()
    try {
      await c.monitor.subscribe(c.destination)
      c.data.announcement = scheduled({ ...c.older })
      c.data.failHistoryPage = 0
      await c.monitor.poll()
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(false)
      c.clock.advance(300_000)
      c.data.announcement = null
      c.data.latest = c.newest
      c.data.rows = [c.older, c.newest]
      await c.reload().monitor.poll()
      const sub = (await c.store.subscription(c.destination.id))!
      expect(sub.baselineExecutionKeys).not.toContain(resetKey(c.older))
      expect(await c.store.executionDeliveries(sub.id, sub.generation, [resetKey(c.older)])).toHaveLength(1)
      expect(c.messages()).toHaveLength(2)
    } finally { await c.app.stop() }
  })

  it('saves initial exclusions only after eligible notifications are durable and recovers an interrupted enqueue', async () => {
    const c = await setup()
    try {
      c.clock.advance(-3600_000)
      await c.monitor.subscribe(c.existing)
      await c.monitor.poll()
      c.clock.advance(NOW - c.clock.now())
      await c.monitor.subscribe(c.destination)
      c.clock.advance(120_000)
      c.data.latest = c.newest
      c.data.rows = [c.older, c.newest]
      const enqueue = c.store.enqueue.bind(c.store)
      vi.spyOn(c.store, 'enqueue').mockImplementation(async value => {
        if (value.subscriptionId === c.destination.id) throw new Error('enqueue interrupted')
        return enqueue(value)
      })
      await expect(c.monitor.poll()).rejects.toThrow('enqueue interrupted')
      const incomplete = (await c.store.subscription(c.destination.id))!
      expect(incomplete.baselined).toBe(false)
      expect(incomplete.baselineExecutionKeys).not.toContain(resetKey(c.older))
      await c.reload().monitor.poll()
      expect((await c.store.subscription(c.destination.id))?.baselineExecutionKeys).toContain(resetKey(c.older))
      expect(c.messages()).toHaveLength(1)
      c.clock.advance(300_000)
      c.data.latest = c.older
      await c.reload().monitor.poll()
      expect(c.messages()).toHaveLength(1)
    } finally { await c.app.stop() }
  })
})
