import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexApi } from '../src/api'
import { Monitor, resetKey } from '../src/monitor'
import type { ResetType, Subscription } from '../src/types'
import { makeClock, NOW, reset, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')
afterEach(() => vi.restoreAllMocks())

async function setup(type: 'channel' | 'private', reset_type: ResetType = 'regular') {
  const app = new App()
  app.plugin(Memory)
  app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx) } })
  await app.start()
  const store = new KoishiStore(app), clock = makeClock(), signal = new AbortController().signal
  const original = reset({ id: '2114588174249071102', reset_type, announced_at: new Date(NOW + 3000_000).toISOString(), source: { type: 'x_post' } })
  const observed = reset({ ...original, id: `observed-${original.id}`, announced_at: new Date(NOW + 4200_000).toISOString(), source: { type: 'observed' } })
  const newest = reset({ id: '2115273253711409208', announced_at: new Date(NOW + 4800_000).toISOString() })
  let current = status(), historyVisible = false
  const rows = [original, observed, newest], historyFrom: number[] = []
  const api = new CodexApi(async url => {
    const parsed = new URL(url)
    if (parsed.pathname.endsWith('/status')) return { status: 200, headers: new Headers(), body: current }
    const from = Date.parse(parsed.searchParams.get('from')!)
    if (historyVisible) historyFrom.push(from) // Inspect the execution update, excluding empty initial checks.
    return { status: 200, headers: new Headers(), body: {
      data: historyVisible ? rows.filter(row => Date.parse(row.announced_at) >= from) : [], pagination: { has_more: false, next_cursor: null },
    } }
  }, { clock, signal, cacheMs: 300_000, stateStore: store })
  const send = vi.fn(async (_target: Subscription, _content: string) => {})
  const options = { clock, signal, sendDelayMs: 1000, report: vi.fn() }
  const monitor = new Monitor(store, api, send, options)
  const existing = target('existing', 'channel', 'bot-a', 'qq'), destination = target('new', type, 'bot-a', 'qq')
  await monitor.subscribe(existing)
  await monitor.poll()
  clock.advance(3600_000)
  await monitor.subscribe(destination)
  return { app, store, clock, monitor, api, options, send, original, observed, newest, rows, destination, existing, historyFrom,
    setCurrent: (latest = newest) => { current = status({ latest_reset: latest }); historyVisible = true } }
}

describe('linked records retain per-subscription execution eligibility', () => {
  it.each([
    ['channel', 'regular', false], ['private', 'regular', false], ['channel', 'banked', false], ['private', 'banked', false],
    ['channel', 'regular', true], ['private', 'regular', true],
  ] as const)('delivers the later observation once in %s for %s; previously baselined=%s', async (type, resetType, baselined) => {
    const c = await setup(type, resetType)
    try {
      if (baselined) await c.monitor.poll()
      c.clock.advance(3600_000)
      c.setCurrent()
      await c.monitor.poll()
      expect(c.historyFrom[0]).toBeLessThan(Date.parse(c.original.announced_at))
      const sub = (await c.store.subscription(c.destination.id))!
      const deliveries = await c.store.executionDeliveries(sub.id, sub.generation, [resetKey(c.original), resetKey(c.observed)])
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.payload?.reset).toEqual(c.observed)
      expect(sub.baselined).toBe(true)
      expect(c.send.mock.calls.filter(([target]) => target.id === sub.id)).toHaveLength(2)
      for (let count = 0; count < 2; count++) {
        c.clock.advance(300_000)
        await new Monitor(new KoishiStore(c.app), c.api, c.send, c.options).poll()
      }
      expect(c.send.mock.calls.filter(([target]) => target.id === sub.id)).toHaveLength(2)
      expect(c.historyFrom).toHaveLength(1)
    } finally { await c.app.stop() }
  })

  it('does not baseline away a later observation when latest uses the older original timestamp', async () => {
    const c = await setup('private')
    try {
      c.rows.pop() // This execution is still latest; history holds its later observation.
      c.clock.advance(3600_000)
      c.setCurrent(c.original)
      await c.monitor.poll()
      const sub = (await c.store.subscription(c.destination.id))!
      expect(sub.baselineResetKey).toBe('')
      const deliveries = await c.store.executionDeliveries(sub.id, sub.generation, [resetKey(c.original), resetKey(c.observed)])
      expect(deliveries).toHaveLength(1)
      expect(deliveries[0]?.payload?.reset).toEqual(c.observed)
    } finally { await c.app.stop() }
  })

  it('recovers eligibility after an enqueue failure and database reload without replaying existing deliveries', async () => {
    const c = await setup('private')
    try {
      c.clock.advance(3600_000)
      c.setCurrent()
      const enqueue = c.store.enqueue.bind(c.store)
      vi.spyOn(c.store, 'enqueue').mockImplementation(async value => {
        if (value.subscriptionId === c.destination.id) throw new Error('enqueue interrupted')
        return enqueue(value)
      })
      await expect(c.monitor.poll()).rejects.toThrow('enqueue interrupted')
      expect((await c.store.subscription(c.destination.id))?.baselined).toBe(false)
      const restored = new KoishiStore(c.app)
      await new Monitor(restored, c.api, c.send, c.options).poll()
      const sub = (await restored.subscription(c.destination.id))!
      expect(await restored.executionDeliveries(sub.id, sub.generation, [resetKey(c.original), resetKey(c.observed)])).toHaveLength(1)
      expect(c.send.mock.calls.filter(([target]) => target.id === c.destination.id)).toHaveLength(2)
      expect(c.send.mock.calls.filter(([target]) => target.id === c.existing.id)).toHaveLength(2)
    } finally { await c.app.stop() }
  })

  it('continues excluding the whole linked event if it was known before the subscription generation', async () => {
    const c = await setup('private')
    try {
      await c.monitor.unsubscribe(c.destination)
      await c.store.saveExecutions([resetKey(c.original)])
      await c.monitor.subscribe(c.destination)
      c.clock.advance(3600_000)
      c.setCurrent()
      await c.monitor.poll()
      const sub = (await c.store.subscription(c.destination.id))!
      expect(await c.store.executionDeliveries(sub.id, sub.generation, [resetKey(c.original), resetKey(c.observed)])).toEqual([])
      expect(c.send.mock.calls.filter(([target]) => target.id === c.destination.id)).toHaveLength(1)
    } finally { await c.app.stop() }
  })
})
