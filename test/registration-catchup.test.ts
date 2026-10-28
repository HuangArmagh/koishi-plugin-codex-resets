import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApi } from '../src/api'
import { Monitor, resetKey } from '../src/monitor'
import type { Reset, ResetType, Subscription } from '../src/types'
import { makeClock, NOW, reset, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

afterEach(() => vi.restoreAllMocks())

async function setup(type: 'channel' | 'private' = 'private', reset_type: ResetType = 'regular', gap = 1000) {
  const app = new App()
  app.plugin(Memory)
  app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx) } })
  await app.start()
  const store = new KoishiStore(app), clock = makeClock(), signal = new AbortController().signal
  const previous = reset({ id: '100', announced_at: new Date(NOW - 7200_000).toISOString() })
  const original = reset({ id: '2114588174249071102', reset_type,
    announced_at: new Date(NOW + 1800_000).toISOString(), source: { type: 'x_post' } })
  let latest: Reset | null = previous
  const rows: Reset[] = [original]
  const requests: { pathname: string; at: number; from: number }[] = []
  let holdHistory = false, historyFailure = 0
  let entered!: () => void, release!: () => void
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const transport: ConstructorParameters<typeof CodexApi>[0] = async url => {
    const parsed = new URL(url), from = Date.parse(parsed.searchParams.get('from') ?? '')
    requests.push({ pathname: parsed.pathname, at: clock.now(), from })
    if (parsed.pathname.endsWith('/status')) return { status: 200, headers: new Headers(), body: status({ latest_reset: latest }) }
    if (holdHistory) { holdHistory = false; entered(); await held }
    if (historyFailure) {
      const code = historyFailure
      historyFailure = 0
      return { status: code, headers: new Headers(), body: { error: { message: 'Reset data is temporarily unavailable.' } } }
    }
    return { status: 200, headers: new Headers(), body: {
      data: rows.filter(row => Date.parse(row.announced_at) >= from), pagination: { has_more: false, next_cursor: null },
    } }
  }
  const send = vi.fn(async (_target: Subscription, _content: string) => {})
  const options = { clock, signal, sendDelayMs: 1000, report: vi.fn() }
  const createRuntime = (database = store) => {
    const api = new CodexApi(transport, { clock, signal, cacheMs: 300_000, stateStore: database })
    return { store: database, api, monitor: new Monitor(database, api, send, options) }
  }
  const runtime = createRuntime()
  const existing = target('existing', 'channel', 'bot-a', 'qq'), destination = target('new', type, 'bot-a', 'qq')
  await runtime.monitor.subscribe(existing)
  await runtime.monitor.poll()
  clock.advance(3600_000)
  latest = original
  holdHistory = true
  const polling = runtime.monitor.poll()
  await waiting
  clock.advance(gap)
  await runtime.monitor.subscribe(destination)
  const registration = (await store.subscription(destination.id))!
  clock.advance(gap)
  const observed = reset({ ...original, id: `observed-${original.id}`,
    announced_at: new Date(clock.now()).toISOString(), source: { type: 'observed' } })
  rows.push(observed)
  release()
  await polling
  return { ...runtime, app, clock, options, send, original, observed, previous, rows, requests, registration, destination, existing,
    reload: () => createRuntime(new KoishiStore(app)),
    setLatest: (value: Reset | null) => { latest = value },
    failHistory: (code = 503) => { historyFailure = code },
    historyRequests: () => requests.filter(request => request.pathname.endsWith('/resets')),
    newMessages: () => send.mock.calls.filter(([target]) => target.id === destination.id),
  }
}

describe('new subscriptions catch up execution evidence saved by an in-flight poll', () => {
  it.each([
    ['channel', 'regular', false, 1000], ['private', 'regular', false, 1000],
    ['channel', 'banked', false, 1000], ['private', 'banked', false, 1000],
    ['channel', 'regular', true, 0], ['private', 'regular', true, 0],
    ['channel', 'banked', true, 0], ['private', 'banked', true, 0],
  ] as const)('delivers %s %s once; reload=%s, registration/observation gap=%s', async (type, resetType, reload, gap) => {
    const c = await setup(type, resetType, gap)
    try {
      expect(c.registration.baselineExecutionKeys).toEqual([resetKey(c.previous)])
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(false)
      expect(await c.store.checkpoint()).toMatchObject({ latestResetKey: resetKey(c.original) })
      expect(c.newMessages()).toHaveLength(0)
      const runtime = reload ? c.reload() : c
      await runtime.monitor.poll()
      const sub = (await runtime.store.subscription(c.destination.id))!
      expect(sub).toMatchObject({ baselined: true, baselineResetKey: '', baselineExecutionKeys: c.registration.baselineExecutionKeys })
      expect(c.historyRequests()).toHaveLength(2)
      expect(c.historyRequests()[1]!.from).toBeLessThanOrEqual(sub.subscribedAt)
      expect(c.newMessages()).toHaveLength(1)
      const deliveries = await runtime.store.executionDeliveries(sub.id, sub.generation, [resetKey(c.original), resetKey(c.observed)])
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.payload?.reset).toEqual(c.observed)
      c.setLatest(c.observed)
      for (let count = 0; count < 2; count++) {
        c.clock.advance(300_000)
        await c.reload().monitor.poll()
      }
      expect(c.newMessages()).toHaveLength(1)
      expect(c.historyRequests()).toHaveLength(2)
      expect(c.send.mock.calls.filter(([target]) => target.id === c.existing.id)).toHaveLength(1)
      expect(c.requests.slice(1).every((request, index) => request.at - c.requests[index]!.at >= 5000)).toBe(true)
    } finally { await c.app.stop() }
  })

  it('retains initialization and the checkpoint on HTTP failure, then catches up after the persisted cooldown', async () => {
    const c = await setup()
    try {
      const checkpoint = await c.store.checkpoint()
      c.failHistory()
      await c.monitor.poll()
      expect(c.options.report).toHaveBeenCalledTimes(1)
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(false)
      expect(await c.store.checkpoint()).toEqual(checkpoint)
      expect(c.newMessages()).toHaveLength(0)
      const retryAt = c.api.retryAt
      expect(retryAt - c.clock.now()).toBe(300_000)
      const restored = c.reload(), requestsBefore = c.requests.length
      c.clock.advance(299_999)
      await expect(restored.monitor.poll()).rejects.toThrow()
      expect(c.requests).toHaveLength(requestsBefore)
      c.clock.advance(1)
      await restored.monitor.poll()
      expect(c.newMessages()).toHaveLength(1)
      expect((await restored.store.subscription(c.destination.id))?.baselineResetKey).toBe('')
      expect((await restored.store.subscription(c.destination.id))?.baselined).toBe(true)
    } finally { await c.app.stop() }
  })

  it('recovers after the new subscription enqueue fails without replaying the existing conversation', async () => {
    const c = await setup()
    try {
      const enqueue = c.store.enqueue.bind(c.store)
      vi.spyOn(c.store, 'enqueue').mockImplementation(async value => {
        if (value.subscriptionId === c.destination.id) throw new Error('enqueue interrupted')
        return enqueue(value)
      })
      await expect(c.monitor.poll()).rejects.toThrow('enqueue interrupted')
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(false)
      await c.reload().monitor.poll()
      expect(c.newMessages()).toHaveLength(1)
      expect(c.send.mock.calls.filter(([target]) => target.id === c.existing.id)).toHaveLength(1)
    } finally { await c.app.stop() }
  })

  it.each(['known', 'absent'] as const)('still catches up when latest is %s, using all saved evidence rather than only the checkpoint ID', async latest => {
    const c = await setup()
    try {
      const value = latest === 'known' ? c.previous : null
      c.setLatest(value)
      await c.store.saveCheckpoint({ latestResetKey: value ? resetKey(value) : null,
        latestResetAt: value?.announced_at ?? null, checkedAt: c.clock.now() })
      await c.reload().monitor.poll()
      expect(c.newMessages()).toHaveLength(1)
      expect(c.historyRequests()).toHaveLength(2)
    } finally { await c.app.stop() }
  })

  it('does not backfill pre-registration records merely because they were learned later', async () => {
    const c = await setup()
    try {
      c.rows[1] = { ...c.observed, announced_at: c.original.announced_at }
      await c.monitor.poll()
      expect(c.historyRequests()).toHaveLength(2)
      expect(c.newMessages()).toHaveLength(0)
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(true)
    } finally { await c.app.stop() }
  })

  it('does not fetch history or replay known linked events for a replacement subscription generation', async () => {
    const c = await setup()
    try {
      await c.monitor.unsubscribe(c.destination)
      c.clock.advance(1000)
      await c.monitor.subscribe(c.destination)
      const replacement = (await c.store.subscription(c.destination.id))!
      expect(replacement.generation).not.toBe(c.registration.generation)
      expect(replacement.baselineExecutionKeys).toContain(resetKey(c.observed))
      c.setLatest(c.observed)
      await c.reload().monitor.poll()
      expect(c.newMessages()).toHaveLength(0)
      expect(c.historyRequests()).toHaveLength(1)
    } finally { await c.app.stop() }
  })
})
