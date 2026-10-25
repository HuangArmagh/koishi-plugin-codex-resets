import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { Monitor, resetKey } from '../src/monitor'
import type { Store, Subscription } from '../src/types'
import { makeApi, makeClock, MemoryStore, NOW, reset, status, target } from './helpers'
import { hash } from '../src/util'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const Mock = require('@koishijs/plugin-mock').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

function setup(store: Store = new MemoryStore()) {
  const clock = makeClock(), { api, state } = makeApi()
  const send = vi.fn(async (_target: Subscription, _content: string) => {})
  const options = { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() }
  return { store, clock, api, state, send, options, monitor: new Monitor(store, api, send, options) }
}

async function databaseSetup() {
  const app = new App()
  app.plugin(Memory)
  const mock = app.plugin(Mock)
  let store!: InstanceType<typeof KoishiStore>
  app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx); store = new KoishiStore(ctx) } })
  await app.start()
  return { app, store, close: async () => { await mock.dispose(); await app.stop() } }
}

describe('execution baselines per subscription generation', () => {
  it.each([
    ['regular', false], ['regular', true], ['banked', false], ['banked', true],
  ] as const)('does not send a known old %s reset after latest rolls back; reload=%s', async (reset_type, reload) => {
    const { app, store, close } = await databaseSetup()
    try {
      const { monitor, clock, api, state, send, options } = setup(store)
      const earlier = reset({ id: 'earlier', reset_type })
      const newer = reset({ id: 'newer', announced_at: new Date(NOW + 1000).toISOString() })
      state.current = status({ latest_reset: earlier })
      await monitor.subscribe(target('existing'))
      await monitor.poll()
      clock.advance(60_000)
      state.current = status({ latest_reset: newer })
      api.history.mockResolvedValue({ data: [earlier, newer], pagination: { has_more: false, next_cursor: null } })
      await monitor.poll()
      clock.advance(60_000)
      await monitor.subscribe(target('new-subscriber'))
      await monitor.poll()
      expect((await store.subscription(target('new-subscriber').id))?.baselineExecutionKeys).toEqual(expect.arrayContaining([resetKey(earlier), resetKey(newer)]))
      send.mockClear()
      clock.advance(60_000)
      state.current = status({ latest_reset: earlier })
      const active = reload ? new Monitor(new KoishiStore(app), api, send, options) : monitor
      await active.poll()
      expect(send.mock.calls.filter(([destination]) => destination.targetId === 'new-subscriber')).toHaveLength(0)
    } finally { await close() }
  })

  it('distinguishes events known before registration from later confirmation in the same millisecond', async () => {
    const { monitor, clock, state, send, store } = setup()
    await monitor.subscribe(target('existing'))
    await monitor.poll()
    await monitor.subscribe(target('new'))
    await monitor.poll()
    expect(clock.now()).toBe(NOW)
    const before = await store.subscription(target('new').id)
    expect(before?.baselineExecutionKeys).toContain(resetKey(reset()))
    const late = reset({ id: 'late-confirmed', announced_at: new Date(NOW - 7200_000).toISOString() })
    state.current = status({ latest_reset: late })
    await monitor.poll()
    expect(send.mock.calls.filter(([destination]) => destination.targetId === 'new')).toHaveLength(1)
    expect((await store.subscription(target('new').id))?.baselineExecutionKeys).not.toContain(resetKey(late))
  })

  it('preserves eligibility across execution persistence followed by a failed enqueue and reload', async () => {
    const { monitor, clock, api, state, send, store, options } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    const late = reset({ id: 'late', announced_at: new Date(NOW - 7200_000).toISOString() })
    state.current = status({ latest_reset: late })
    vi.spyOn(store, 'enqueue').mockRejectedValueOnce(new Error('delivery write failed'))
    await expect(monitor.poll()).rejects.toThrow('delivery write failed')
    expect(await store.hasExecution(resetKey(late))).toBe(true)
    expect(send).not.toHaveBeenCalled()
    await new Monitor(store, api, send, options).poll()
    expect(send).toHaveBeenCalledTimes(1)
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps the baseline on language changes and captures a fresh one after cancellation', async () => {
    const { monitor, clock, state, send, store } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    const original = await store.subscription(target().id)
    clock.advance(60_000)
    const later = reset({ id: 'later', announced_at: new Date(NOW - 7200_000).toISOString() })
    state.current = status({ latest_reset: later })
    await monitor.poll()
    await monitor.subscribe(target(), 'en-US')
    expect(await store.subscription(target().id)).toMatchObject({ generation: original!.generation, baselineExecutionKeys: original!.baselineExecutionKeys })
    await monitor.unsubscribe(target())
    await monitor.subscribe(target(), 'en-US')
    expect((await store.subscription(target().id))?.baselineExecutionKeys).toContain(resetKey(later))
    expect((await store.subscription(target().id))?.generation).not.toBe(original?.generation)
    send.mockClear()
    state.current = status({ latest_reset: reset() })
    await monitor.poll()
    state.current = status({ latest_reset: later })
    await monitor.poll()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not suppress a newly confirmed type sharing an ID with an old execution', async () => {
    const { monitor, clock, state, send, store } = setup()
    await store.saveExecutions([resetKey(reset())])
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ latest_reset: reset({ reset_type: 'banked' }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toContain('储备重置')
  })

  it('does not create an incomplete subscription when reading the execution baseline fails', async () => {
    const { monitor, store } = setup()
    vi.spyOn(store, 'executionKeys').mockRejectedValueOnce(new Error('database unavailable'))
    await expect(monitor.subscribe(target())).rejects.toThrow('database unavailable')
    expect(await store.subscriptions()).toHaveLength(0)
    await expect(monitor.subscribe(target())).resolves.toBe(true)
    expect((await store.subscription(target().id))?.baselineExecutionKeys).toEqual([])
  })

  it('orders registration after execution evidence persisted by an in-flight polling mutation', async () => {
    const { monitor, store, state } = setup()
    await monitor.subscribe(target('existing'))
    await monitor.poll()
    state.current = status({ latest_reset: reset({ id: 'newly-confirmed' }) })
    let entered!: () => void, release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const save = store.saveExecutions.bind(store)
    vi.spyOn(store, 'saveExecutions').mockImplementationOnce(async keys => { await save(keys); entered(); await held })
    const polling = monitor.poll()
    await started
    const registration = monitor.subscribe(target('new'))
    release()
    await Promise.all([polling, registration])
    expect((await store.subscription(target('new').id))?.baselineExecutionKeys).toContain('reset:regular:newly-confirmed')
  })
})

describe('legacy execution baseline recovery', () => {
  it('uses dated evidence without classifying all legacy executions as pre-subscription events', async () => {
    const { app, store, close } = await databaseSetup()
    try {
      const destination = target()
      const ownBaseline = 'reset:regular:baseline'
      await app.database.create('codex_reset_subscription', { ...destination, generation: 'legacy', subscribedAt: NOW, baselined: true, baselineResetKey: ownBaseline })
      for (const [key, createdAt] of [['old', NOW - 1000], ['late', NOW + 1000]] as const) {
        await app.database.create('codex_reset_delivery', { id: key, subscriptionId: 'another-subscription', generation: 'other',
          eventKey: 'reset:regular:' + key, kind: 'reset', createdAt, sentAt: createdAt, content: 'legacy' })
      }
      await app.database.create('codex_reset_execution', { id: hash(['reset:regular:undated']), eventKey: 'reset:regular:undated' })
      await app.database.create('codex_reset_state', { id: 'global', snapshot: { latestResetKey: 'reset:regular:checkpoint', latestResetAt: reset().announced_at, checkedAt: NOW - 1000 } })
      const recovered = await store.subscription(destination.id)
      expect(recovered?.baselineExecutionKeys?.sort()).toEqual([ownBaseline, 'reset:regular:checkpoint', 'reset:regular:old'].sort())
      expect((await new KoishiStore(app).subscription(destination.id))?.baselineExecutionKeys).toEqual(recovered?.baselineExecutionKeys)
      const { monitor, clock, state, send } = setup(store)
      state.current = status({ latest_reset: reset({ id: 'old' }) })
      await monitor.poll()
      expect(send).not.toHaveBeenCalled()
      clock.advance(60_000)
      state.current = status({ latest_reset: reset({ id: 'late' }) })
      await monitor.poll()
      expect(send).toHaveBeenCalledTimes(1)
      await monitor.subscribe(target('new'))
      expect((await store.subscription(target('new').id))?.baselineExecutionKeys).toContain('reset:regular:undated')
    } finally { await close() }
  })

  it('gates operations and retries an interrupted legacy baseline write without deleting subscriptions', async () => {
    const { app, store, close } = await databaseSetup()
    try {
      await app.database.create('codex_reset_subscription', { ...target(), generation: 'legacy', subscribedAt: NOW,
        baselined: true, baselineResetKey: resetKey(reset()) })
      const set = app.database.set.bind(app.database)
      vi.spyOn(app.database, 'set').mockImplementationOnce(async (table, ...args) => {
        if (table === 'codex_reset_subscription') throw new Error('baseline write failed')
        return set(table, ...args)
      })
      await expect(store.deleteSubscription(target().id)).rejects.toThrow('baseline write failed')
      expect(await app.database.get('codex_reset_subscription', {})).toHaveLength(1)
      expect((await store.subscription(target().id))?.baselineExecutionKeys).toEqual([resetKey(reset())])
    } finally { await close() }
  })
})
