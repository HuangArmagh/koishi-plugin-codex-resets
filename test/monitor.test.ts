import { describe, expect, it, vi } from 'vitest'
import { formatReset, formatScheduled } from '../src/format'
import { Monitor } from '../src/monitor'
import { CodexApi } from '../src/api'
import type { Subscription } from '../src/types'
import { enqueueResetFixtures, makeApi, makeClock, MemoryStore, NOW, reset, status, target, scheduled, watch } from './helpers'

function setup(initial = status()) {
  const store = new MemoryStore()
  const clock = makeClock()
  const { api, state } = makeApi(initial)
  const send = vi.fn(async (_target: Subscription, _content: string) => {})
  const report = vi.fn()
  const controller = new AbortController()
  const options = { clock, sendDelayMs: 1000, signal: controller.signal, report }
  const monitor = new Monitor(store, api, send, options)
  return { store, clock, api, state, send, report, controller, options, monitor }
}

describe('explicit conversation subscriptions', () => {
  it.each(['refresh', 'backoff'])('revalidates a delayed submission after announcement %s', async condition => {
    const store = new MemoryStore(), clock = makeClock(), { api } = makeApi(status({ scheduled_reset: scheduled() }))
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const waiting = new Promise<void>(resolve => { entered = resolve })
    const submitted = vi.fn(async () => {})
    const monitor = new Monitor(store, api, async (_target, _content, submitCurrent) => {
      entered()
      await held
      const pending = await submitCurrent(submitted)
      if (!pending) return false
      await pending.completion
    }, { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
    await monitor.subscribe(target())
    const polling = monitor.poll()
    await waiting
    if (condition === 'refresh') monitor.invalidateAnnouncements()
    else Object.defineProperty(api, 'retryAt', { value: clock.now() + 60_000 })
    release()
    await polling
    expect(submitted).not.toHaveBeenCalled()
    expect(await store.pending(clock.now())).toEqual([expect.objectContaining({ sentAt: 0, attempts: 0 })])
  })

  it('discards queued legacy diagnostic messages on upgrade without changing real notifications', async () => {
    const { monitor, store, send } = setup()
    await monitor.subscribe(target())
    await enqueueResetFixtures(store, target(), 3)
    const rows = [...store.deliveries.values()]
    rows[0]!.eventKey = 'test:legacy:watch'
    rows[1]!.payload = { type: 'test', kind: 'reset', at: NOW }
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.deliveries.size).toBe(1)
    expect(store.deliveries.has(rows[2]!.id)).toBe(true)
  })

  it.each(['success', 'failure'])('allows cancellation while an already submitted send is waiting for adapter %s', async result => {
    const { monitor, send, store } = setup()
    await monitor.subscribe(target())
    await enqueueResetFixtures(store, target())
    let started!: () => void, release!: () => void
    const submitted = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    send.mockImplementationOnce(async () => {
      started()
      await held
      if (result === 'failure') throw new Error('adapter failed after cancellation')
    })
    const draining = monitor.drain()
    await submitted
    try {
      await monitor.unsubscribe(target())
      expect(await monitor.isSubscribed(target())).toBe(false)
      // Starting a new subscription must not revive the second message from the old batch.
      await monitor.subscribe(target())
    } finally {
      release()
    }
    await draining
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.deliveries.size).toBe(0)
  })

  it('uses updated announcement details when a drain already captured an older delivery', async () => {
    const { monitor, state, clock, send, store } = setup(status({ scheduled_reset: scheduled({ scheduled_for: new Date(NOW + 10_000).toISOString() }) }))
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    clock.advance(60_000)
    let read!: () => void, release!: () => void, updated!: () => void
    const snapshotRead = new Promise<void>(resolve => { read = resolve })
    const announcementUpdated = new Promise<void>(resolve => { updated = resolve })
    const pending = store.pending.bind(store)
    vi.spyOn(store, 'pending').mockImplementationOnce(async now => {
      const snapshot = await pending(now)
      read()
      await new Promise<void>(resolve => { release = resolve })
      return snapshot
    })
    const draining = monitor.drain()
    await snapshotRead
    state.current = status({ scheduled_reset: scheduled({ text: 'updated announcement details' }) })
    const enqueue = store.enqueue.bind(store)
    vi.spyOn(store, 'enqueue').mockImplementation(async value => {
      await enqueue(value)
      updated()
    })
    const polling = monitor.poll()
    await announcementUpdated
    release()
    await Promise.all([draining, polling])
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1]).toBe(formatScheduled(state.current.data.scheduled_reset!))
    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1])
    expect([...store.deliveries.values()][0]?.payload?.scheduled?.text).toBe('updated announcement details')
    expect([...store.deliveries.values()][0]).toMatchObject({ expiresAt: 0, sentAt: clock.now() })
  })

  it('does not expire pending announcements when their scheduled time passes', async () => {
    const { monitor, clock, send } = setup(status({ scheduled_reset: scheduled({ scheduled_for: new Date(NOW + 10_000).toISOString() }) }))
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    clock.advance(60_000)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1]).toContain('重置预告')
    expect(send.mock.calls[1]?.[1]).not.toContain('已执行重置')
  })

  it('does not establish a new subscription baseline from a pre-subscription cache', async () => {
    const context = setup()
    let snapshot = status()
    const transport = vi.fn(async () => ({ status: 200, headers: new Headers(), body: structuredClone(snapshot) }))
    const api = new CodexApi(transport, { clock: context.clock, cacheMs: 300_000, signal: context.controller.signal })
    const monitor = new Monitor(context.store, api, context.send, context.options)
    await api.status()
    context.clock.advance(60_000)
    snapshot = status({ latest_reset: reset({ id: 'before-subscription', announced_at: new Date(context.clock.now()).toISOString() }) })
    context.clock.advance(60_000)
    await monitor.subscribe(target())
    await monitor.poll()
    context.clock.advance(300_001)
    await monitor.poll()
    expect(context.send).not.toHaveBeenCalled()
    expect(transport).toHaveBeenCalledTimes(3)
  })

  it('recovers an earlier-announced scheduled execution across restart and a newer reset', async () => {
    const scheduled = { ...reset({ id: 'scheduled', text: 'scheduled-executed' }), status: 'scheduled' as const, scheduled_for: new Date(NOW + 60_000).toISOString() }
    const context = setup(status({ scheduled_reset: scheduled }))
    await context.monitor.subscribe(target())
    await context.monitor.poll()
    context.send.mockClear()
    context.clock.advance(600_000)
    const newer = reset({ id: 'newer', text: 'newer-executed', announced_at: new Date(NOW + 300_000).toISOString() })
    context.state.current = status({ latest_reset: newer })
    context.api.history.mockImplementation(async from => ({
      data: [reset({ id: scheduled.id, text: scheduled.text }), newer].filter(item => Date.parse(item.announced_at) >= Date.parse(from)),
      pagination: { has_more: false, next_cursor: null },
    }))
    const restarted = new Monitor(context.store, context.api, context.send, context.options)
    await restarted.poll()
    expect(context.send.mock.calls.map(([, message]) => message)).toEqual([formatReset(reset({ id: scheduled.id })), formatReset(newer)])
    await restarted.poll()
    expect(context.send).toHaveBeenCalledTimes(2)
  })

  it('continues checking a disappeared scheduled announcement without inferring execution', async () => {
    const scheduled = { ...reset({ id: 'scheduled' }), status: 'scheduled' as const, scheduled_for: new Date(NOW - 1).toISOString() }
    const { monitor, state, clock, api, send } = setup(status({ scheduled_reset: scheduled }))
    await monitor.subscribe(target())
    await monitor.poll()
    send.mockClear()
    expect(api.history).not.toHaveBeenCalled()
    clock.advance(60_000)
    state.current = status()
    await monitor.poll()
    expect(api.history).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
    api.history.mockResolvedValueOnce({ data: [reset({ id: scheduled.id })], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps pending execution evidence across a failed catch-up and another restart', async () => {
    const scheduled = { ...reset({ id: 'scheduled' }), status: 'scheduled' as const, scheduled_for: null }
    const context = setup(status({ scheduled_reset: scheduled }))
    await context.monitor.subscribe(target())
    await context.monitor.poll()
    context.send.mockClear()
    context.state.current = status()
    context.api.history.mockRejectedValueOnce(new Error('history offline'))
    await context.monitor.poll()
    expect(context.send).not.toHaveBeenCalled()
    context.api.history.mockResolvedValueOnce({ data: [reset({ id: scheduled.id })], pagination: { has_more: false, next_cursor: null } })
    const restarted = new Monitor(context.store, context.api, context.send, context.options)
    await restarted.poll()
    expect(context.send).toHaveBeenCalledTimes(1)
    expect((await context.store.subscription(target().id))?.pendingResets).toEqual([])
  })

  it('does not replay another subscription\'s pending execution to a newly joined target', async () => {
    const scheduled = { ...reset({ id: 'scheduled' }), status: 'scheduled' as const, scheduled_for: null }
    const { monitor, api, state, clock, send } = setup(status({ scheduled_reset: scheduled }))
    await monitor.subscribe(target())
    await monitor.poll()
    send.mockClear()
    clock.advance(600_000)
    const newer = reset({ id: 'newer', announced_at: new Date(NOW + 300_000).toISOString() })
    state.current = status({ latest_reset: newer })
    api.history.mockResolvedValueOnce({ data: [reset({ id: scheduled.id }), newer], pagination: { has_more: false, next_cursor: null } })
    await monitor.subscribe(target('group-b'))
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(([destination]) => destination.targetId === 'group-a')).toBe(true)
  })

  it('defers subscriptions registered during an in-flight snapshot and catches up their events', async () => {
    const { monitor, api, state, store, clock, send } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    let release!: () => void
    let started!: () => void
    const inFlight = new Promise<void>(resolve => { started = resolve })
    api.status.mockImplementationOnce(async () => {
      const snapshot = structuredClone(state.current)
      started()
      await new Promise<void>(resolve => { release = resolve })
      return snapshot
    })
    const checking = monitor.poll()
    await inFlight
    clock.advance(1000)
    await monitor.subscribe(target('group-b'))
    const middle = reset({ id: 'middle', announced_at: new Date(NOW + 2000).toISOString() })
    const latest = reset({ id: 'latest', announced_at: new Date(NOW + 3000).toISOString() })
    clock.advance(3000)
    state.current = status({ latest_reset: latest })
    release()
    await checking
    expect((await store.subscription(target('group-b').id))?.baselined).toBe(false)
    api.history.mockResolvedValueOnce({ data: [middle, latest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send.mock.calls.filter(([destination]) => destination.targetId === 'group-b')).toHaveLength(2)
  })

  it('retries an incomplete new-subscription catch-up even when the global checkpoint is current', async () => {
    const { monitor, api, state, store, clock, send } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(1000)
    await monitor.subscribe(target('group-b'))
    const middle = reset({ id: 'middle', announced_at: new Date(NOW + 2000).toISOString() })
    const latest = reset({ id: 'latest', announced_at: new Date(NOW + 3000).toISOString() })
    clock.advance(3000)
    state.current = status({ latest_reset: latest })
    // Another target's in-flight poll can finish after group-b registers and advance the shared checkpoint.
    await store.saveCheckpoint({ latestResetKey: 'reset:regular:latest', latestResetAt: latest.announced_at, checkedAt: clock.now() })
    api.history.mockRejectedValueOnce(new Error('history unavailable'))
    await monitor.poll()
    expect((await store.subscription(target('group-b').id))?.baselined).toBe(false)
    api.history.mockResolvedValueOnce({ data: [middle, latest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send.mock.calls.filter(([destination]) => destination.targetId === 'group-b')).toHaveLength(2)
    expect((await store.subscription(target('group-b').id))?.baselined).toBe(true)
  })

  it('drains newly queued resets when a previous delivery is still in flight', async () => {
    const { monitor, send, clock, store } = setup()
    const times: number[] = []
    send.mockImplementation(async () => { times.push(clock.now()) })
    await monitor.subscribe(target())
    await monitor.subscribe(target('user-a', 'private'))
    await enqueueResetFixtures(store, target())
    let release!: () => void
    const started = new Promise<void>(resolve => {
      send.mockImplementationOnce(async () => {
        times.push(clock.now())
        resolve()
        await new Promise<void>(done => { release = done })
      })
    })
    const first = monitor.drain()
    await started
    await enqueueResetFixtures(store, target('user-a', 'private'))
    const second = monitor.drain()
    release()
    await Promise.all([first, second])
    expect(send).toHaveBeenCalledTimes(4)
    expect(send.mock.calls.map(([destination]) => destination.targetId)).toEqual(['group-a', 'group-a', 'user-a', 'user-a'])
    expect(times.slice(1).every((time, index) => time - times[index]! >= 1000)).toBe(true)
  })

  it('keeps the send interval between separate drain calls', async () => {
    const { monitor, send, clock, store } = setup()
    const times: number[] = []
    send.mockImplementation(async () => { times.push(clock.now()) })
    await monitor.subscribe(target())
    await monitor.subscribe(target('user-a', 'private'))
    await enqueueResetFixtures(store, target())
    await monitor.drain()
    await enqueueResetFixtures(store, target('user-a', 'private'))
    await monitor.drain()
    expect(times).toHaveLength(4)
    expect(times.slice(1).every((time, index) => time - times[index]! >= 1000)).toBe(true)
  })

  it('never fetches or sends when no conversation has subscribed', async () => {
    const { monitor, api, send } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.poll()
    expect(api.status).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('pushes only announcements and executed resets to registered targets', async () => {
    const { monitor, state, clock, send } = setup()
    await monitor.subscribe(target())
    await monitor.subscribe(target('user-a', 'private'))
    clock.advance(1000)
    state.current = status({ scheduled_reset: scheduled(), latest_reset: reset({ announced_at: new Date(clock.now()).toISOString() }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(4)
    expect(send.mock.calls.map(([destination]) => destination.targetId)).toEqual(['group-a', 'group-a', 'user-a', 'user-a'])
    expect(send.mock.calls.map(([, message]) => message).filter(message => message.includes('【Codex 重置预告】'))).toHaveLength(2)
    expect(send.mock.calls.map(([, message]) => message).filter(message => message.includes('【Codex 已执行重置】'))).toHaveLength(2)
    expect(send.mock.calls.every(([, message]) => message.includes('https://codex-resets.com'))).toBe(true)
  })

  it('treats group/private, bot account, and platform as different subscriptions', async () => {
    const { monitor, store } = setup()
    await monitor.subscribe(target('same-id'))
    await monitor.subscribe(target('same-id', 'private'))
    await monitor.subscribe(target('same-id', 'channel', 'bot-b'))
    await monitor.subscribe(target('same-id', 'channel', 'bot-a', 'other'))
    expect(store.subs.size).toBe(4)
    expect(await monitor.unsubscribe(target('same-id', 'private'))).toBe(true)
    expect(store.subs.size).toBe(3)
    expect(await monitor.isSubscribed(target('same-id'))).toBe(true)
  })

  it('does not replay old resets on first subscription, but sends the current pending announcement', async () => {
    const { monitor, send } = setup(status({ scheduled_reset: scheduled() }))
    expect(await monitor.subscribe(target())).toBe(true)
    expect(await monitor.subscribe(target())).toBe(false)
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toContain('重置预告')
  })

  it('does not send scheduled announcements as executed, even after their scheduled time', async () => {
    const { monitor, send } = setup(status({ scheduled_reset: {
      ...reset({ id: 'scheduled-1' }), status: 'scheduled', scheduled_for: new Date(NOW - 10_000).toISOString(),
    } }))
    await monitor.subscribe(target())
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toContain('重置预告')
    expect(send.mock.calls[0]?.[1]).not.toContain('已执行重置')
  })

  it('pushes a later execution even if its original announcement predates subscription', async () => {
    const scheduled = { ...reset({ id: 'scheduled-before-subscription' }), status: 'scheduled' as const, scheduled_for: new Date(NOW + 60_000).toISOString() }
    const { monitor, state, clock, send } = setup(status({ scheduled_reset: scheduled }))
    await monitor.subscribe(target())
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    send.mockClear()
    clock.advance(60_000)
    state.current = status({ latest_reset: reset({ id: scheduled.id, announced_at: scheduled.announced_at }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toContain('已执行重置')
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('persists deduplication across a restart and ignores changing response metadata', async () => {
    const context = setup(status({ scheduled_reset: scheduled() }))
    await context.monitor.subscribe(target())
    await context.monitor.poll()
    context.state.current.meta.generated_at = new Date(NOW + 60_000).toISOString()
    const restarted = new Monitor(context.store, context.api, context.send, context.options)
    await restarted.poll()
    expect(context.send).toHaveBeenCalledTimes(1)
  })

  it('never queues forecasts, including new or revised 100 percent signals', async () => {
    const { monitor, state, send, store } = setup()
    await monitor.subscribe(target())
    for (const prediction of [watch(), watch({ reset_chance_percent: 100 }), watch({ reset_chance_percent: 100, observed_at: new Date(NOW).toISOString() }), watch({ level: 'strong', reset_chance_percent: null }), null]) {
      state.current = status({ active_watch: prediction })
      await monitor.poll()
    }
    expect(send).not.toHaveBeenCalled()
    expect(store.deliveries.size).toBe(0)
  })

  it('catches up intermediate resets using all cursor pages', async () => {
    const { monitor, state, clock, api, send } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    const middle = reset({ id: 'middle', announced_at: new Date(NOW + 10_000).toISOString(), reset_type: 'banked' })
    const latest = reset({ id: 'latest', announced_at: new Date(NOW + 50_000).toISOString() })
    state.current = status({ latest_reset: latest })
    api.history.mockResolvedValueOnce({ data: [middle], pagination: { has_more: true, next_cursor: 'next_page' } })
      .mockResolvedValueOnce({ data: [latest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(api.history).toHaveBeenCalledTimes(2)
    expect(api.history.mock.calls[1]?.[1]).toBe('next_page')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0]?.[1]).toContain('储备重置已发放')
  })

  it('catches up all post-subscription resets after the first requests failed', async () => {
    const { monitor, clock, state, api, send } = setup()
    await monitor.subscribe(target())
    api.status.mockRejectedValueOnce(new Error('offline'))
    await expect(monitor.poll()).rejects.toThrow('offline')
    const middle = reset({ id: 'middle', text: 'middle-reset', announced_at: new Date(NOW + 60_000).toISOString() })
    const latest = reset({ id: 'latest', text: 'latest-reset', announced_at: new Date(NOW + 120_000).toISOString() })
    clock.advance(180_000)
    state.current = status({ latest_reset: latest })
    api.history.mockResolvedValueOnce({ data: [middle], pagination: { has_more: true, next_cursor: 'next_page' } })
      .mockResolvedValueOnce({ data: [latest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(api.history.mock.calls[0]?.[0]).toBe(new Date(NOW).toISOString())
    expect(api.history.mock.calls[1]?.[1]).toBe('next_page')
    expect(send.mock.calls.map(([, content]) => content)).toEqual([formatReset(middle), formatReset(latest)])
  })

  it('retains a missing initial checkpoint until the full first catch-up succeeds', async () => {
    const { monitor, clock, state, api, send, store } = setup()
    await monitor.subscribe(target())
    clock.advance(60_000)
    const middle = reset({ id: 'middle', announced_at: new Date(NOW + 1000).toISOString() })
    const latest = reset({ id: 'latest', announced_at: new Date(NOW + 2000).toISOString() })
    state.current = status({ latest_reset: latest })
    api.history.mockRejectedValueOnce(new Error('history unavailable'))
    await monitor.poll()
    expect(store.state).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    api.history.mockResolvedValueOnce({ data: [middle, latest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(store.state?.latestResetKey).toContain('latest')
  })

  it('preserves the checkpoint and pauses announcements after history fails while delivering executions', async () => {
    const { monitor, state, clock, api, store, send } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    const previous = structuredClone(store.state)
    clock.advance(1000)
    state.current = status({ latest_reset: reset({ id: 'new', announced_at: new Date(clock.now()).toISOString() }), scheduled_reset: scheduled() })
    api.history.mockRejectedValueOnce(new Error('503 unavailable'))
    await monitor.poll()
    expect(store.state).toEqual(previous)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![1]).toContain('已执行重置')
    await monitor.poll()
    expect(store.state?.latestResetKey).toContain('new')
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]![1]).toContain('重置预告')
  })

  it('retries only failed targets and cancellation removes pending retries', async () => {
    const { monitor, clock, send, store } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.subscribe(target())
    await monitor.subscribe(target('group-b'))
    send.mockImplementation(async subscription => { if (subscription.targetId === 'group-a') throw new Error('offline') })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect([...store.deliveries.values()].filter(delivery => !delivery.sentAt)).toHaveLength(1)
    await monitor.unsubscribe(target())
    clock.advance(60_000)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(2)
    expect(await monitor.isSubscribed(target('group-b'))).toBe(true)
  })

  it('does not deliver a previous subscription generation after cancellation and re-subscription', async () => {
    const { monitor, clock, send, store } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    const stale = structuredClone([...store.deliveries.values()][0]!)
    await monitor.unsubscribe(target())
    await monitor.subscribe(target())
    store.deliveries.set(stale.id, stale)
    clock.advance(60_000)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not resend an already delivered announcement after content or scheduled-time changes', async () => {
    const { monitor, state, send } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.subscribe(target())
    await monitor.poll()
    state.current = status({ scheduled_reset: scheduled({ text: 'revised announcement', scheduled_for: null }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('cancels a failed announcement when the next snapshot confirms execution', async () => {
    const { monitor, state, clock, send, store } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('bot offline'))
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ scheduled_reset: null, latest_reset: reset({ id: 'confirmed', announced_at: new Date(clock.now()).toISOString() }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1]).toContain('已执行重置')
    expect([...store.deliveries.values()].some(delivery => !delivery.sentAt && delivery.eventKey.startsWith('scheduled:'))).toBe(false)
  })

  it('sends only the current announcement when an older failed announcement was superseded', async () => {
    const { monitor, state, clock, send } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('bot offline'))
    await monitor.poll()
    clock.advance(60_000)
    state.current = status({ scheduled_reset: scheduled({ id: 'new-announcement', text: 'replacement announcement', scheduled_for: new Date(NOW + 7200_000).toISOString() }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1]).toBe(formatScheduled(state.current.data.scheduled_reset!))
    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1])
  })

  it('holds restored announcement retries until a fresh snapshot validates them', async () => {
    const context = setup(status({ scheduled_reset: scheduled() }))
    await context.monitor.subscribe(target())
    context.send.mockRejectedValueOnce(new Error('offline'))
    await context.monitor.poll()
    context.clock.advance(60_000)
    const restarted = new Monitor(context.store, context.api, context.send, context.options)
    await restarted.drain()
    expect(context.send).toHaveBeenCalledTimes(1)
    context.state.current = status({ scheduled_reset: null })
    await restarted.poll()
    expect(context.send).toHaveBeenCalledTimes(1)
  })

  it('checks announcement validity again after a pending delivery snapshot was already read', async () => {
    const { monitor, state, clock, send, store } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.subscribe(target())
    await monitor.subscribe(target('group-b'))
    send.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    clock.advance(60_000)
    let release!: () => void
    const started = new Promise<void>(resolve => {
      send.mockImplementationOnce(async () => {
        resolve()
        await new Promise<void>(done => { release = done })
      })
    })
    const draining = monitor.drain()
    await started
    let cancelled!: () => void
    const cancellation = new Promise<void>(resolve => { cancelled = resolve })
    const originalCancel = store.cancelScheduledExcept.bind(store)
    vi.spyOn(store, 'cancelScheduledExcept').mockImplementation(async key => {
      await originalCancel(key)
      cancelled()
    })
    state.current = status({ scheduled_reset: null })
    const polling = monitor.poll()
    await cancellation
    release()
    await Promise.all([draining, polling])
    // The first retry was already in flight; the second must be cancelled.
    expect(send).toHaveBeenCalledTimes(3)
    expect(send.mock.calls[2]?.[0].targetId).toBe('group-a')
  })

  it('coalesces overlapping polls and stops work after plugin disposal', async () => {
    const { monitor, api, send, controller } = setup(status({ scheduled_reset: scheduled() }))
    await monitor.subscribe(target())
    await Promise.all([monitor.poll(), monitor.poll()])
    expect(api.status).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    controller.abort()
    await expect(monitor.poll()).rejects.toThrow()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
