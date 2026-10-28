import { createRequire } from 'node:module'
import { afterEach, describe, it, expect, vi } from 'vitest'
import { apiHttpResponse, NOW, reset, scheduled, status, target, enqueueResetFixtures, MemoryStore, makeClock, makeApi } from './helpers'
import { CodexApi } from '../src/api'
import { Monitor } from '../src/monitor'
import type { Subscription } from '../src/types'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const Mock = require('@koishijs/plugin-mock').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { KoishiStore } = require('../lib/store') as typeof import('../src/store')

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

function setupDelivery() {
  vi.useFakeTimers({ now: NOW })
  const store = new MemoryStore(), clock = makeClock(), { api } = makeApi()
  const controller = new AbortController(), report = vi.fn()
  const send = vi.fn(async (_destination: Subscription, _content: string) => {})
  const monitor = new Monitor(store, api, send, { clock, signal: controller.signal, sendDelayMs: 1000, report })
  return { store, clock, controller, send, monitor, report }
}

describe('delivery isolation and history backoff', () => {
  it('continues polling and delivering to other conversations while one adapter call stalls', async () => {
    vi.useFakeTimers({ now: NOW })
    vi.spyOn(require('../lib/util').clock, 'sleep').mockImplementation(ms => new Promise(resolve => setTimeout(resolve, ms)))
    const app = new App()
    app.plugin(Memory)
    const mock = app.plugin(Mock)
    const http = vi.fn(async (url: string) => apiHttpResponse(url, status()))
    app.http = http as unknown as typeof app.http
    app.plugin(plugin, { pollIntervalMs: 60_000 })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    await app.start()
    try {
      await vi.advanceTimersByTimeAsync(0)
      const bot = app.bots[0]!
      const store = new KoishiStore(app)
      const a = target('slow-adapter', 'private', bot.selfId, bot.platform)
      const b = target('healthy-adapter', 'private', bot.selfId, bot.platform)
      for (const destination of [a, b]) {
        await store.saveSubscription({ ...destination, locale: 'zh-CN', generation: destination.targetId, subscribedAt: NOW,
          baselined: true, baselineResetKey: 'reset:regular:' + reset().id, baselineExecutionKeys: [] })
        await enqueueResetFixtures(store, destination, 1)
      }
      const send = vi.spyOn(bot, 'sendPrivateMessage').mockImplementation(async userId => {
        if (userId === a.targetId) await held
        return ['message-id']
      })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).not.toHaveBeenCalled()
      // These restored subscriptions have no checkpoint: cover history before draining.
      await vi.advanceTimersByTimeAsync(5000)
      expect(send.mock.calls.map(call => call[0])).toEqual([a.targetId])
      const requestsBeforeStall = http.mock.calls.length
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect.soft(http.mock.calls.length).toBeGreaterThan(requestsBeforeStall)
      expect.soft(send.mock.calls.map(call => call[0])).toEqual([a.targetId, b.targetId])
    } finally {
      release()
      await vi.advanceTimersByTimeAsync(2000)
      await mock.dispose()
      await app.stop()
      vi.restoreAllMocks()
      vi.useRealTimers()
    }
  })

  it.each(['active', 'withdrawn', 'executed'] as const)('pauses announcements on history 429 and recovers when %s', async outcome => {
    const store = new MemoryStore(), clock = makeClock()
    const signal = new AbortController().signal
    let current = status({ scheduled_reset: scheduled() })
    let limited = false, executed = false
    const requests: string[] = []
    const api = new CodexApi(async (url: string) => {
      requests.push(url)
      return url.includes('/resets?')
        ? limited ? { status: 429, headers: new Headers({ 'Retry-After': '600' }), body: {} }
          : { status: 200, headers: new Headers(), body: { data: executed ? [reset({ ...scheduled() })] : [], pagination: { has_more: false, next_cursor: null } } }
        : { status: 200, headers: new Headers(), body: structuredClone(current) }
    }, { cacheMs: 60_000, signal, clock, stateStore: store })
    const send = vi.fn(async (_destination: unknown, _content: string) => {})
      .mockRejectedValueOnce(new Error('adapter unavailable'))
    const monitor = new Monitor(store, api, send, { clock, signal, sendDelayMs: 1000, report: vi.fn() })
    await monitor.subscribe(target())
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    limited = true
    clock.advance(60_000)
    current = status({ latest_reset: reset({ id: 'newer', announced_at: new Date(NOW + 30_000).toISOString() }), scheduled_reset: scheduled() })
    await monitor.poll()
    expect(api.retryAt).toBeGreaterThan(clock.now())
    expect(requests.filter(url => url.includes('/resets?'))).toHaveLength(2)
    const titles = send.mock.calls.map(([, content]) => content.split('\n')[0])
    expect(titles.filter(title => title === '【Codex 重置预告】')).toHaveLength(1)
    expect(titles.filter(title => title === '【Codex 已执行重置】')).toHaveLength(1)
    const queued = [...store.deliveries.values()].find(delivery => delivery.kind === 'scheduled')!
    expect(queued).toMatchObject({ attempts: 1, sentAt: 0 })
    const retryAt = queued.retryAt, requestCount = requests.length
    await monitor.drain()
    expect(queued.retryAt).toBe(retryAt)
    expect(send).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(requestCount)
    limited = false
    executed = outcome === 'executed'
    clock.advance(600_000)
    if (outcome === 'withdrawn') current.data.scheduled_reset = null
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(outcome === 'withdrawn' ? 2 : 3)
    if (outcome !== 'withdrawn') expect(send.mock.calls[2]![1]).toContain(outcome === 'active' ? '重置预告' : '已执行重置')
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(outcome === 'withdrawn' ? 2 : 3)
  })

  it.each(['success', 'failure'] as const)('tracks late %s without resubmitting an unknown outcome or overtaking it', async outcome => {
    const { monitor, store, clock, send } = setupDelivery()
    let finish!: () => void, fail!: (error: Error) => void
    send.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject }))
    await monitor.subscribe(target())
    await monitor.subscribe(target('healthy'))
    await enqueueResetFixtures(store, target(), 2)
    await enqueueResetFixtures(store, target('healthy'), 1)
    const firstId = [...store.deliveries.keys()][0]!
    const draining = monitor.drain()
    await vi.advanceTimersByTimeAsync(30_000)
    await draining
    expect(send.mock.calls.map(([destination]) => destination.targetId)).toEqual(['group-a', 'healthy'])
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(2)
    expect(await store.delivery(firstId)).toMatchObject({ sentAt: 0, attempts: 0 })
    if (outcome === 'success') finish()
    else fail(new Error('late rejection'))
    await vi.advanceTimersByTimeAsync(0)
    const settled = (await store.delivery(firstId))!
    if (outcome === 'success') expect(settled.sentAt).toBeGreaterThan(0)
    else expect(settled).toMatchObject({ attempts: 1, retryAt: clock.now() + 30_000 })
    clock.advance(60_000)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(outcome === 'success' ? 3 : 4)
    expect((await store.pending(clock.now()))).toEqual([])
  })

  it('does not resurrect cancelled deliveries when a previous generation completes late', async () => {
    const { monitor, store, send } = setupDelivery()
    let finish!: () => void
    send.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await monitor.subscribe(target())
    await enqueueResetFixtures(store, target(), 1)
    const oldId = [...store.deliveries.keys()][0]!
    const draining = monitor.drain()
    await vi.advanceTimersByTimeAsync(30_000)
    await draining
    await monitor.unsubscribe(target())
    await monitor.subscribe(target())
    await enqueueResetFixtures(store, target(), 1)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await store.delivery(oldId)).toBeUndefined()
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('ends a pending wait on disposal and ignores the late adapter result', async () => {
    const { monitor, store, send, controller, report } = setupDelivery()
    let fail!: (error: Error) => void
    send.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { fail = reject }))
    await monitor.subscribe(target())
    await enqueueResetFixtures(store, target(), 1)
    const draining = monitor.drain()
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await draining
    fail(new Error('late after disposal'))
    await vi.advanceTimersByTimeAsync(0)
    expect([...store.deliveries.values()][0]).toMatchObject({ sentAt: 0, attempts: 0 })
    expect(report).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['success', 'failure'] as const)('revalidates a stale batch after late %s', async outcome => {
    const { monitor, store, send } = setupDelivery()
    let finish!: () => void, fail!: (error: Error) => void
    send.mockImplementationOnce(() => new Promise<void>((resolve, reject) => { finish = resolve; fail = reject }))
    await monitor.subscribe(target())
    await enqueueResetFixtures(store, target(), 1)
    const draining = monitor.drain()
    await vi.advanceTimersByTimeAsync(30_000)
    await draining
    const pending = store.pending.bind(store)
    vi.spyOn(store, 'pending').mockImplementationOnce(async now => {
      const stale = await pending(now)
      if (outcome === 'success') finish()
      else fail(new Error('late failure while reading'))
      await vi.advanceTimersByTimeAsync(0)
      return stale
    })
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('pauses announcements if another API read starts backoff after validation', async () => {
    const store = new MemoryStore(), clock = makeClock(), { api: base } = makeApi(status({ scheduled_reset: scheduled() }))
    const api = Object.assign(base, { retryAt: 0 })
    const send = vi.fn(async () => {}).mockRejectedValueOnce(new Error('offline'))
    const monitor = new Monitor(store, api, send, { clock, signal: new AbortController().signal, sendDelayMs: 1000, report: vi.fn() })
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    api.retryAt = clock.now() + 600_000
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
    clock.advance(600_000)
    api.retryAt = 0
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
  })
})
