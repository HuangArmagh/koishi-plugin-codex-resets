import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { CodexApi } from '../src/api'
import { Monitor, resetKey } from '../src/monitor'
import type { Reset, ResetType, Store, Subscription } from '../src/types'
import { makeClock, MemoryStore, NOW, reset, scheduled, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

function setup(initialSendFailed = false, resetType: ResetType = 'regular', store: Store = new MemoryStore()) {
  const clock = makeClock(), signal = new AbortController().signal
  const announcement = scheduled({ reset_type: resetType, announced_at: new Date(NOW - 7200_000).toISOString() })
  const previous = reset()
  const executed = reset({ ...announcement })
  const newest = reset({ id: 'newer-execution', announced_at: new Date(NOW + 30_000).toISOString() })
  const state = {
    current: status({ latest_reset: previous, scheduled_reset: announcement }),
    records: [previous] as Reset[], pageSize: 100, limited: false,
  }
  const requests: { url: URL; at: number }[] = []
  const api = new CodexApi(async url => {
    const parsed = new URL(url)
    requests.push({ url: parsed, at: clock.now() })
    if (parsed.pathname.endsWith('/status')) return { status: 200, headers: new Headers(), body: structuredClone(state.current) }
    if (state.limited) return { status: 429, headers: new Headers({ 'Retry-After': '600' }), body: {} }
    const from = Date.parse(parsed.searchParams.get('from')!)
    const rows = state.records.filter(record => Date.parse(record.announced_at) >= from)
      .sort((left, right) => Date.parse(left.announced_at) - Date.parse(right.announced_at))
    const offset = Number((parsed.searchParams.get('cursor') ?? 'page_0').slice(5))
    const end = offset + Math.min(state.pageSize, Number(parsed.searchParams.get('limit')))
    return { status: 200, headers: new Headers(), body: {
      data: rows.slice(offset, end),
      pagination: { has_more: end < rows.length, next_cursor: end < rows.length ? `page_${end}` : null },
    } }
  }, { clock, signal, cacheMs: 60_000, stateStore: store })
  const send = vi.fn(async (_destination: Subscription, _content: string) => {})
  if (initialSendFailed) send.mockRejectedValueOnce(new Error('offline'))
  const options = { clock, signal, sendDelayMs: 1000, report: vi.fn() }
  const monitor = new Monitor(store, api, send, options)
  const historyRequests = () => requests.filter(request => request.url.pathname.endsWith('/resets'))
  const advance = (includeExecution = true) => {
    clock.advance(60_000)
    state.current = status({ latest_reset: newest, scheduled_reset: announcement })
    const unrelated = reset({ id: 'unrelated-before-subscription', announced_at: new Date(NOW - 1800_000).toISOString() })
    state.records = [...(includeExecution ? [executed] : []), previous, unrelated, newest]
  }
  return { monitor, store, clock, api, send, options, announcement, executed, newest, state, requests, historyRequests, advance }
}

describe('history catch-up includes the current pending announcement', () => {
  it.each([
    [false, 'regular'], [true, 'regular'], [false, 'banked'], [true, 'banked'],
  ] as const)('confirms the old execution without replaying its announcement or unrelated history; failed=%s type=%s', async (failed, type) => {
    const { monitor, store, clock, send, announcement, executed, newest, historyRequests, advance } = setup(failed, type)
    await monitor.subscribe(target())
    await monitor.poll()
    advance()
    await monitor.poll()
    expect(historyRequests()[0]!.url.searchParams.get('from')).toBe(announcement.announced_at)
    expect(await store.hasExecution(resetKey(executed))).toBe(true)
    const subscription = (await store.subscription(target().id))!
    expect(subscription.pendingResets).toEqual([])
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.filter(([, message]) => message.includes('重置预告'))).toHaveLength(1)
    expect(send.mock.calls[1]![1]).toContain(type === 'banked' ? '储备重置已发放' : '已执行重置')
    expect((await store.checkpoint())?.latestResetKey).toBe(resetKey(newest))
    for (let index = 0; index < 2; index++) { clock.advance(60_000); await monitor.poll() }
    expect(send).toHaveBeenCalledTimes(3)
    expect(historyRequests()).toHaveLength(1)
  })

  it('keeps a stable pending announcement from triggering unnecessary history requests', async () => {
    const { monitor, clock, send, historyRequests } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    for (let index = 0; index < 3; index++) { clock.advance(60_000); await monitor.poll() }
    expect(historyRequests()).toEqual([])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('retries a genuinely pending announcement after a complete history check finds no execution', async () => {
    const { monitor, store, send, announcement, executed, historyRequests, advance } = setup(true)
    await monitor.subscribe(target())
    await monitor.poll()
    advance(false)
    await monitor.poll()
    expect(historyRequests()[0]!.url.searchParams.get('from')).toBe(announcement.announced_at)
    expect(await store.hasExecution(resetKey(executed))).toBe(false)
    expect((await store.subscription(target().id))?.pendingResets).toEqual([{ key: resetKey(executed), announcedAt: announcement.announced_at }])
    expect(send.mock.calls.filter(([, message]) => message.includes('重置预告'))).toHaveLength(2)
    expect(send.mock.calls.filter(([, message]) => message.includes('已执行重置'))).toHaveLength(1)
  })

  it('keeps the expanded time boundary on every page and shares the five-second request spacing', async () => {
    const { monitor, store, state, requests, announcement, executed, send, historyRequests, advance } = setup(true)
    await monitor.subscribe(target())
    await monitor.poll()
    state.pageSize = 1
    advance()
    await monitor.poll()
    expect(historyRequests().map(({ url }) => url.searchParams.get('from'))).toEqual(Array(4).fill(announcement.announced_at))
    expect(historyRequests().map(({ url }) => url.searchParams.get('cursor'))).toEqual([null, 'page_1', 'page_2', 'page_3'])
    expect(requests.slice(1).every((request, index) => request.at - requests[index]!.at >= 5000)).toBe(true)
    expect(await store.hasExecution(resetKey(executed))).toBe(true)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('holds retries through history backoff and retains the earlier boundary after monitor recreation', async () => {
    const { monitor, store, state, clock, api, send, options, announcement, executed, historyRequests, advance } = setup(true)
    await monitor.subscribe(target())
    await monitor.poll()
    const checkpoint = await store.checkpoint()
    advance()
    state.limited = true
    await monitor.poll()
    expect(api.retryAt).toBeGreaterThan(clock.now())
    expect(await store.checkpoint()).toEqual(checkpoint)
    expect(send).toHaveBeenCalledTimes(2) // Initial failed announcement and the new confirmed execution.
    expect((await store.pending(clock.now())).find(delivery => delivery.kind === 'scheduled')).toMatchObject({ attempts: 1, sentAt: 0 })
    const restarted = new Monitor(store, api, send, options)
    await restarted.drain()
    expect(send).toHaveBeenCalledTimes(2)
    state.limited = false
    clock.advance(600_000)
    await restarted.poll()
    expect(historyRequests().map(({ url }) => url.searchParams.get('from'))).toEqual([announcement.announced_at, announcement.announced_at])
    expect(await store.hasExecution(resetKey(executed))).toBe(true)
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls.filter(([, message]) => message.includes('重置预告'))).toHaveLength(1)
  })

  it('retains the observed time in Koishi storage and deduplicates after a store reload', async () => {
    const app = new App()
    app.plugin(Memory)
    let store!: InstanceType<typeof KoishiStore>
    app.plugin({ inject: ['database'], apply(ctx) { defineModels(ctx); store = new KoishiStore(ctx) } })
    await app.start()
    try {
      const { monitor, api, send, options, clock, announcement, executed, historyRequests, advance } = setup(true, 'regular', store)
      await monitor.subscribe(target())
      await monitor.poll()
      advance()
      const restoredStore = new KoishiStore(app)
      const restarted = new Monitor(restoredStore, api, send, options)
      await restarted.poll()
      expect(historyRequests()[0]!.url.searchParams.get('from')).toBe(announcement.announced_at)
      expect(await restoredStore.hasExecution(resetKey(executed))).toBe(true)
      const rows = await app.database.get('codex_reset_delivery', { kind: 'reset' })
      expect(rows.map(row => row.eventKey).sort()).toEqual([resetKey(executed), 'reset:regular:newer-execution'].sort())
      expect(rows.every(row => row.sentAt > 0)).toBe(true)
      clock.advance(60_000)
      await new Monitor(new KoishiStore(app), api, send, options).poll()
      expect(send).toHaveBeenCalledTimes(3)
      await restarted.unsubscribe(target())
      await restarted.subscribe(target())
      await restarted.poll()
      expect(send).toHaveBeenCalledTimes(3)
    } finally { await app.stop() }
  })
})
