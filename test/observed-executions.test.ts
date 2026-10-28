import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { Monitor, resetKey } from '../src/monitor'
import type { Reset, ResetType, Store, Subscription } from '../src/types'
import { hash } from '../src/util'
import { makeApi, makeClock, MemoryStore, NOW, reset, scheduled, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

// Public announcement IDs from the supplied October 26/28 API snapshots.
function setup(resetType: ResetType = 'regular', store: Store = new MemoryStore()) {
  const clock = makeClock()
  const announcement = scheduled({ id: '2114588174249071102', reset_type: resetType,
    announced_at: new Date(NOW - 120_000).toISOString(),
    source: { type: 'x_post', url: 'https://x.com/thsottiaux/status/2114588174249071102' } })
  const executed = reset({ id: `observed-${announcement.id}`, reset_type: resetType,
    announced_at: new Date(NOW + 30_000).toISOString(), source: { type: 'observed', url: announcement.source.url } })
  const next = scheduled({ id: '2115273253711409208', announced_at: new Date(NOW + 60_000).toISOString() })
  const { api, state } = makeApi(status({ scheduled_reset: announcement }))
  api.history.mockResolvedValue({ data: [executed], pagination: { has_more: false, next_cursor: null } })
  const send = vi.fn(async (_destination: Subscription, _content: string) => {})
  const options = { clock, signal: new AbortController().signal, sendDelayMs: 1000, report: vi.fn() }
  const monitor = new Monitor(store, api, send, options)
  return { monitor, api, state, store, clock, send, options, announcement, executed, next }
}

describe('observed executions resolve their original announcements', () => {
  it.each([
    ['channel', 'regular'], ['private', 'regular'], ['channel', 'banked'], ['private', 'banked'],
  ] as const)('clears the old announcement and stops repeated history reads in %s for %s', async (type, resetType) => {
    const { monitor, api, state, store, clock, send, announcement, executed } = setup(resetType)
    const destination = target('destination', type, 'bot-a', 'qq')
    await monitor.subscribe(destination)
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ latest_reset: executed })
    await monitor.poll()
    expect((await store.subscription(destination.id))?.pendingResets).toEqual([])
    expect(await store.hasExecution(resetKey(announcement))).toBe(true)
    expect(await store.hasExecution(resetKey(executed))).toBe(true)
    expect(api.history).toHaveBeenCalledTimes(1) // New latest reset still requires a gap check.
    for (let index = 0; index < 3; index++) { clock.advance(60_000); await monitor.poll() }
    expect(api.history).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![1]).toContain(resetType === 'banked' ? '储备重置已发放' : '已执行重置')
  })

  it.each(['channel', 'private'] as const)('heals a previously delivered 0.5.4 event without replay or a history request in %s', async type => {
    const { monitor, api, state, store, clock, send, options, executed, next } = setup()
    const destination = target('destination', type)
    await monitor.subscribe(destination)
    await monitor.poll()
    clock.advance(60_000)
    const subscription = (await store.subscription(destination.id))!
    // Model 0.5.4: execution delivered and checkpoint advanced, original pending ID retained.
    const key = resetKey(executed)
    const delivery = { id: hash([destination.id, subscription.generation, key]), subscriptionId: destination.id,
      generation: subscription.generation, eventKey: key, kind: 'reset' as const,
      content: 'already sent', payload: { type: 'reset' as const, reset: executed },
      createdAt: clock.now(), expiresAt: 0, retryAt: 0, attempts: 0, sentAt: clock.now() }
    await store.enqueue(delivery)
    await store.saveExecutions([key])
    await store.saveCheckpoint({ latestResetKey: key, latestResetAt: executed.announced_at, checkedAt: clock.now() })
    state.current = status({ latest_reset: executed, scheduled_reset: next })
    api.history.mockRejectedValue(new Error('HTTP 503: history unavailable'))
    send.mockClear()
    const upgraded = new Monitor(store, api, send, options)
    await upgraded.poll()
    expect(api.history).not.toHaveBeenCalled()
    expect(options.report).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toContain('重置预告')
    expect((await store.subscription(destination.id))?.pendingResets).toEqual([
      { key: resetKey(next), announcedAt: next.announced_at },
    ])
    expect(await store.delivery(delivery.id)).toEqual(delivery)
    clock.advance(60_000)
    await new Monitor(store, api, send, options).poll()
    expect(api.history).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('still checks gaps and holds new announcements when necessary history fails', async () => {
    const { monitor, api, state, store, clock, send, executed, next } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    const checkpoint = await store.checkpoint()
    clock.advance(60_000)
    state.current = status({ latest_reset: executed, scheduled_reset: next })
    api.history.mockRejectedValueOnce(new Error('HTTP 503'))
    await monitor.poll()
    expect(await store.checkpoint()).toEqual(checkpoint)
    expect(send).toHaveBeenCalledTimes(2) // Old announcement and confirmed execution, no new announcement yet.
    expect(send.mock.calls[1]![1]).toContain('已执行重置')
    await monitor.poll()
    expect(api.history).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[2]![1]).toContain('重置预告')
    await monitor.poll()
    expect(api.history).toHaveBeenCalledTimes(2)
  })

  it('finds an older observed execution in history and retains its eligibility before the subscription time', async () => {
    const { monitor, api, state, store, clock, send, announcement, executed, next } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    executed.announced_at = announcement.announced_at
    const newest = reset({ id: 'newer-execution', announced_at: new Date(NOW + 50_000).toISOString() })
    state.current = status({ latest_reset: newest, scheduled_reset: next })
    api.history.mockResolvedValueOnce({ data: [executed], pagination: { has_more: true, next_cursor: 'page-2' } })
      .mockResolvedValueOnce({ data: [newest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(api.history.mock.calls.map(([from]) => from)).toEqual([announcement.announced_at, announcement.announced_at])
    expect((await store.subscription(target().id))?.pendingResets).toEqual([{ key: resetKey(next), announcedAt: next.announced_at }])
    expect(send.mock.calls.filter(([, content]) => content.includes('已执行重置'))).toHaveLength(2)
    await monitor.poll()
    expect(api.history).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['different type', { reset_type: 'banked' }],
    ['different numeric ID', { id: 'observed-2115273253711409208' }],
    ['not observed', { source: { type: 'x_post' } }],
    ['nested prefix', { id: 'observed-observed-2114588174249071102' }],
    ['partial ID', { id: 'observed-2114588174249071102-extra' }],
    ['trailing newline', { id: 'observed-2114588174249071102\n' }],
  ] satisfies [string, Partial<Reset>][])('does not clear an unrelated pending announcement: %s', async (_name, overrides) => {
    const { monitor, api, state, store, clock, announcement, executed } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    const other = { ...executed, ...overrides }
    state.current = status({ latest_reset: other })
    api.history.mockResolvedValue({ data: [other], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect((await store.subscription(target().id))?.pendingResets).toEqual([{ key: resetKey(announcement), announcedAt: announcement.announced_at }])
    expect(await store.hasExecution(resetKey(announcement))).toBe(false)
  })

  it.each(['saveExecutions', 'enqueue', 'saveSubscription'] as const)('recovers without losing or replaying execution after a %s failure', async operation => {
    const { monitor, api, state, store, clock, send, options, announcement, executed } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    const checkpoint = await store.checkpoint()
    clock.advance(60_000)
    state.current = status({ latest_reset: executed })
    vi.spyOn(store, operation).mockRejectedValueOnce(new Error('database write failed'))
    await expect(monitor.poll()).rejects.toThrow('database write failed')
    expect(await store.checkpoint()).toEqual(checkpoint)
    expect((await store.subscription(target().id))?.pendingResets).toEqual([{ key: resetKey(announcement), announcedAt: announcement.announced_at }])
    const restarted = new Monitor(store, api, send, options)
    await restarted.poll()
    await restarted.poll()
    expect((await store.subscription(target().id))?.pendingResets).toEqual([])
    expect(send).toHaveBeenCalledTimes(2)
    expect(api.history).toHaveBeenCalledTimes(2)
  })

  it.each(['snapshot', 'persisted evidence'] as const)('does not replay an observed record linked to the registration %s', async baseline => {
    const { monitor, api, state, store, clock, send, announcement, executed } = setup()
    if (baseline === 'persisted evidence') await store.saveExecutions([resetKey(announcement)])
    state.current = status({ latest_reset: baseline === 'snapshot' ? reset({ ...announcement }) : reset() })
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ latest_reset: executed })
    await monitor.poll()
    expect(api.history).toHaveBeenCalledTimes(baseline === 'snapshot' ? 0 : 1)
    expect(send).not.toHaveBeenCalled()
  })

  it('persists observed aliases in Koishi storage and suppresses a stale announcement after reload and resubscription', async () => {
    const app = new App()
    app.plugin(Memory)
    let store!: InstanceType<typeof KoishiStore>
    app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx); store = new KoishiStore(ctx) } })
    await app.start()
    try {
      const { monitor, api, state, clock, send, options, announcement, executed } = setup('regular', store)
      await monitor.subscribe(target())
      send.mockRejectedValueOnce(new Error('offline'))
      await monitor.poll()
      clock.advance(60_000)
      state.current = status({ latest_reset: executed, scheduled_reset: announcement })
      await monitor.poll()
      const rows = await app.database.get('codex_reset_delivery', {})
      expect(rows.map(row => row.eventKey)).toEqual([resetKey(executed)])
      expect(rows[0]!.sentAt).toBeGreaterThan(0)
      const restored = new KoishiStore(app)
      expect(await restored.hasExecution(resetKey(announcement))).toBe(true)
      expect((await restored.subscription(target().id))?.pendingResets).toEqual([])
      const restarted = new Monitor(restored, api, send, options)
      await restarted.unsubscribe(target())
      await restarted.subscribe(target())
      state.current = status({ latest_reset: reset(), scheduled_reset: announcement })
      api.history.mockResolvedValue({ data: [executed], pagination: { has_more: false, next_cursor: null } })
      send.mockClear()
      await restarted.poll()
      expect(send).not.toHaveBeenCalled()
      expect((await restored.subscription(target().id))?.pendingResets).toEqual([])
    } finally { await app.stop() }
  })
})
