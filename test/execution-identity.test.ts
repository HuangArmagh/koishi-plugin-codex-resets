import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { executionLink } from '../src/execution'
import { Monitor, resetKey } from '../src/monitor'
import type { Delivery, Store, Subscription } from '../src/types'
import { hash } from '../src/util'
import { makeApi, makeClock, MemoryStore, NOW, reset, scheduled, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')
const original = reset({ id: '2114588174249071102', announced_at: new Date(NOW + 1000).toISOString(), source: { type: 'x_post' } })
const observed = reset({ ...original, id: `observed-${original.id}`, source: { type: 'observed' } })
const pair = executionLink(observed)!

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function setup(store: Store = new MemoryStore()) {
  const clock = makeClock(), { api, state } = makeApi()
  const send = vi.fn(async (_target: Subscription, _content: string) => {})
  const options = { clock, signal: new AbortController().signal, sendDelayMs: 1000, report: vi.fn() }
  return { store, clock, api, state, send, options, monitor: new Monitor(store, api, send, options) }
}

function delivery(subscription: Subscription, record = observed, overrides: Partial<Delivery> = {}): Delivery {
  const eventKey = resetKey(record)
  return { id: hash([subscription.id, subscription.generation, eventKey]), subscriptionId: subscription.id,
    generation: subscription.generation, eventKey, kind: 'reset', content: 'fixture',
    payload: { type: 'reset', reset: record }, createdAt: NOW, expiresAt: 0, attempts: 0, retryAt: 0, sentAt: 0, ...overrides }
}

describe('execution identity deduplicates notifications without changing existing IDs', () => {
  it.each([original, observed])('sends once when status and history use both IDs; latest=$id', async latest => {
    const { monitor, state, api, clock, send, store } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ latest_reset: latest })
    api.history.mockResolvedValue({ data: [original, observed], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await store.executionDeliveries(target().id, (await store.subscription(target().id))!.generation,
      [resetKey(original), resetKey(observed)])).toHaveLength(1)
  })

  it.each([original, observed])('keeps the sent row after an ID switch and reload; first=$id', async first => {
    const { monitor, state, api, clock, send, store, options } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ latest_reset: first })
    api.history.mockResolvedValue({ data: [first], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    const sub = (await store.subscription(target().id))!
    const before = (await store.executionDeliveries(sub.id, sub.generation, [resetKey(first)]))[0]!
    const second = first === original ? observed : original
    clock.advance(60_000)
    state.current = status({ latest_reset: second })
    api.history.mockResolvedValue({ data: [second], pagination: { has_more: false, next_cursor: null } })
    await new Monitor(store, api, send, options).poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await store.delivery(before.id)).toEqual(before)
    expect(api.history).toHaveBeenCalledTimes(1)
  })

  it.each(['sent', 'retrying'] as const)('reconciles two legacy delivery rows while retaining the %s row', async outcome => {
    const { monitor, store, clock, send } = setup()
    await monitor.subscribe(target())
    const sub = (await store.subscription(target().id))!
    const old = delivery(sub, observed, { createdAt: NOW - 1000, attempts: 3,
      retryAt: NOW + 60_000, sentAt: outcome === 'sent' ? NOW - 500 : 0 })
    const duplicate = delivery(sub, original)
    await store.enqueue(old)
    await store.enqueue(duplicate)
    await store.saveExecutions([old.eventKey, duplicate.eventKey], [pair])
    await monitor.drain()
    expect(send).not.toHaveBeenCalled()
    expect(await store.delivery(old.id)).toEqual(old)
    expect(await store.delivery(duplicate.id)).toBeUndefined()
    clock.advance(60_000)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(outcome === 'sent' ? 0 : 1)
    expect((await store.delivery(old.id))?.attempts).toBe(3)
  })

  it('does not overtake an unknown send outcome when the upstream ID changes', async () => {
    vi.useFakeTimers()
    const { monitor, store, state, api, send, clock } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ latest_reset: observed })
    api.history.mockResolvedValue({ data: [observed], pagination: { has_more: false, next_cursor: null } })
    let release!: () => void, started!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    send.mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve }) })
    const polling = monitor.poll()
    await entered
    try {
      await vi.advanceTimersByTimeAsync(30_000)
      await polling
      state.current = status({ latest_reset: original })
      await monitor.poll()
      expect(send).toHaveBeenCalledTimes(1)
      const sub = (await store.subscription(target().id))!
      expect(await store.executionDeliveries(sub.id, sub.generation, [resetKey(original), resetKey(observed)])).toHaveLength(1)
    } finally { release(); await vi.advanceTimersByTimeAsync(0) }
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(['source', 'type', 'id'] as const)('does not merge independent execution records differing in %s', async difference => {
    const { monitor, state, api, send, clock } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    const other = difference === 'source' ? reset({ ...observed, source: { type: 'x_post' } })
      : difference === 'type' ? reset({ ...observed, reset_type: 'banked' })
      : reset({ ...observed, id: 'observed-2115273253711409208' })
    clock.advance(60_000)
    state.current = status({ latest_reset: original })
    api.history.mockResolvedValue({ data: [original, other], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
  })
})

async function legacySetup(type: 'channel' | 'private' = 'channel', sent = true) {
  const app = new App()
  app.plugin(Memory)
  app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx) } })
  await app.start()
  const destination = target('legacy-destination', type, 'bot-a', 'qq')
  const old = reset({ ...observed, announced_at: new Date(NOW - 86400_000).toISOString() })
  const newer = reset({ id: '2115000000000000000', announced_at: new Date(NOW - 3600_000).toISOString() })
  const next = scheduled({ id: '2115273253711409208', announced_at: new Date(NOW - 1000).toISOString() })
  const sub: Subscription = { ...destination, locale: 'zh-CN', generation: 'legacy-generation',
    subscribedAt: NOW - 2 * 86400_000, baselined: true, baselineResetKey: resetKey(reset()), baselineExecutionKeys: [],
    pendingResets: [{ key: pair.originalKey, announcedAt: new Date(NOW - 2 * 86400_000).toISOString() }] }
  const oldDelivery = delivery(sub, old, { createdAt: NOW - 86400_000, attempts: 2,
    retryAt: sent ? 0 : NOW + 60_000, sentAt: sent ? NOW - 86400_000 : 0 })
  await app.database.create('codex_reset_subscription', sub)
  await app.database.create('codex_reset_delivery', oldDelivery)
  await app.database.create('codex_reset_delivery', delivery(sub, newer, { createdAt: NOW - 3600_000, sentAt: NOW - 3600_000 }))
  await app.database.create('codex_reset_state', { id: 'global', snapshot: {
    latestResetKey: resetKey(newer), latestResetAt: newer.announced_at, checkedAt: NOW - 60_000,
  } })
  const store = new KoishiStore(app), context = setup(store)
  context.state.current = status({ latest_reset: newer, scheduled_reset: next })
  context.api.history.mockRejectedValue(new Error('HTTP 503'))
  return { ...context, app, destination, sub, old, newer, next, oldDelivery }
}

describe('legacy execution links are recovered before deciding to query history', () => {
  it.each([['channel', true], ['private', true], ['channel', false], ['private', false]] as const)(
    'lets a new announcement through after latest advanced; %s sent=%s', async (type, sent) => {
      const c = await legacySetup(type, sent)
      try {
        await c.monitor.poll()
        expect(c.api.history).not.toHaveBeenCalled()
        expect(c.send).toHaveBeenCalledTimes(1)
        expect(c.send.mock.calls[0]![1]).toContain('重置预告')
        expect((await c.store.subscription(c.destination.id))?.pendingResets).toEqual([{ key: resetKey(c.next), announcedAt: c.next.announced_at }])
        expect(await c.store.delivery(c.oldDelivery.id)).toEqual(c.oldDelivery)
        expect(await c.store.executionLinks()).toEqual([pair])
        c.clock.advance(60_000)
        const restored = new KoishiStore(c.app)
        await restored.saveExecutions([pair.observedKey, pair.originalKey])
        expect(await restored.executionLinks()).toEqual([pair])
        await new Monitor(restored, c.api, c.send, c.options).poll()
        expect(c.api.history).not.toHaveBeenCalled()
        expect(c.send).toHaveBeenCalledTimes(sent ? 1 : 2)
        expect((await restored.delivery(c.oldDelivery.id))?.attempts).toBe(2)
      } finally { await c.app.stop() }
    },
  )

  it.each(['other conversation', 'other generation', 'evidence only'] as const)('keeps an unqueued execution eligible with %s evidence', async owner => {
    const c = await legacySetup()
    try {
      await c.store.executionLinks() // Persist the validated relationship first.
      if (owner !== 'evidence only') {
        const moved = { ...c.oldDelivery, ...(owner === 'other conversation'
          ? { subscriptionId: 'other-conversation' } : { generation: 'other-generation' }) }
        moved.id = hash([moved.subscriptionId, moved.generation, moved.eventKey])
        await c.app.database.create('codex_reset_delivery', moved)
      }
      await c.app.database.remove('codex_reset_delivery', { id: c.oldDelivery.id })
      await c.monitor.poll()
      expect(c.api.history).toHaveBeenCalledTimes(1)
      expect((await c.store.subscription(c.destination.id))?.pendingResets).toContainEqual(c.sub.pendingResets![0])
      expect(c.send).not.toHaveBeenCalled()
      c.api.history.mockResolvedValue({ data: [c.old], pagination: { has_more: false, next_cursor: null } })
      await c.monitor.poll()
      expect(c.send.mock.calls.filter(([, content]) => content.includes('已执行重置'))).toHaveLength(1)
      expect(c.send.mock.calls.filter(([, content]) => content.includes('重置预告'))).toHaveLength(1)
    } finally { await c.app.stop() }
  })

  it.each(['missing', 'mismatch', 'not observed', 'invalid time'] as const)('does not infer a relationship from a %s legacy payload', async shape => {
    const c = await legacySetup()
    try {
      const payload = shape === 'missing' ? null : { type: 'reset' as const, reset: shape === 'mismatch'
        ? reset({ ...c.old, id: 'observed-2115273253711409208' }) : shape === 'not observed'
          ? reset({ ...c.old, source: { type: 'x_post' } }) : reset({ ...c.old, announced_at: 'invalid' }) }
      await c.app.database.set('codex_reset_delivery', { id: c.oldDelivery.id }, { payload })
      await c.monitor.poll()
      expect(await c.store.executionLinks()).toEqual([])
      expect(c.api.history).toHaveBeenCalledTimes(1)
      expect(c.send).not.toHaveBeenCalled()
    } finally { await c.app.stop() }
  })

  it('retains data and retries after persisting a link or cleaning the pending list fails', async () => {
    const c = await legacySetup()
    try {
      const upsert = c.app.database.upsert.bind(c.app.database)
      vi.spyOn(c.app.database, 'upsert').mockImplementationOnce(async (table, ...args) => {
        if (table === 'codex_reset_execution') throw new Error('link write failed')
        return upsert(table, ...args)
      })
      await expect(c.monitor.poll()).rejects.toThrow('link write failed')
      expect((await c.app.database.get('codex_reset_subscription', {}))[0]!.pendingResets).toEqual(c.sub.pendingResets)
      vi.spyOn(c.store, 'saveSubscription').mockRejectedValueOnce(new Error('pending cleanup failed'))
      await expect(c.monitor.poll()).rejects.toThrow('pending cleanup failed')
      expect(await c.store.delivery(c.oldDelivery.id)).toEqual(c.oldDelivery)
      await new Monitor(new KoishiStore(c.app), c.api, c.send, c.options).poll()
      expect(c.api.history).not.toHaveBeenCalled()
      expect(c.send).toHaveBeenCalledTimes(1)
    } finally { await c.app.stop() }
  })
})
