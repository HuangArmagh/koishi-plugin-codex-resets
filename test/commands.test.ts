import { createRequire } from 'node:module'
import type { App as KoishiApp } from 'koishi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatReset, formatScheduled } from '../src/format'
import { Monitor } from '../src/monitor'
import { ApiError, CodexApi } from '../src/api'
import type { Transport } from '../src/api'
import type { StatusResponse } from '../src/types'
import { defineModels, KoishiStore } from '../src/store'
import { apiHttpResponse, configureOneBotMock, enqueueResetFixtures, makeApi, makeClock, NOW, reset, status, target, scheduled } from './helpers'

// Exercise the emitted CommonJS entry point, matching how Koishi loads this package.
const require = createRequire(import.meta.url)
const { App, h } = require('koishi') as typeof import('koishi')
const Mock = require('@koishijs/plugin-mock').default as typeof import('@koishijs/plugin-mock').default
const Memory = require('@minatojs/driver-memory').default as typeof import('@minatojs/driver-memory').default
const { defaults, registerCommands, targetFromSession } = require('../lib/index.js') as typeof import('../src/index')
const plugin = require('../lib/index.js') as typeof import('../src/index')

const apps: KoishiApp[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop()
})

async function setup(config = defaults) {
  const app = new App({ prefix: '' })
  apps.push(app)
  app.plugin(Memory)
  app.plugin(Mock)
  const { api, state } = makeApi(status({ scheduled_reset: scheduled() }))
  const clock = makeClock()
  const send = vi.fn(async () => {})
  const wake = vi.fn()
  let monitor!: Monitor
  let store!: KoishiStore
  app.plugin({
    inject: ['database'],
    apply(ctx) {
      defineModels(ctx)
      store = new KoishiStore(ctx)
      monitor = new Monitor(store, api, send, {
        clock, sendDelayMs: 1000,
        signal: new AbortController().signal, report: vi.fn(),
      })
      registerCommands(ctx, monitor, api, wake, config)
    },
  })
  await app.start()
    configureOneBotMock(app)
  await app.mock.initUser('alice', 1)
  await app.mock.initUser('bob', 1)
  await app.mock.initChannel('group-a')
  await app.mock.initChannel('group-b')
  return { app, monitor, store, api, state, send, wake, clock }
}

describe('Koishi commands and database integration', () => {
  it('replies once per subscription/cancellation and never sends legacy or new diagnostic messages', async () => {
    vi.useFakeTimers({ now: NOW })
    vi.spyOn(require('../lib/util').clock, 'sleep').mockImplementation(ms => new Promise(resolve => setTimeout(resolve, ms)))
    const app = new App({ prefix: '' })
    apps.push(app)
    try {
      app.plugin(Memory); app.plugin(Mock)
      const http = vi.fn(async (url: string) => apiHttpResponse(url, status()))
      app.http = http as unknown as typeof app.http
      app.plugin(plugin, { pollIntervalMs: 60_000 })
      await app.start()
      await vi.advanceTimersByTimeAsync(0)
      const bot = configureOneBotMock(app)
      await app.mock.initUser('alice', 0)
      await app.mock.initChannel('group-a')
      const original = bot.sendMessage.bind(bot)
      const pushes = vi.fn(async () => ['unexpected-message'])
      vi.spyOn(bot, 'sendMessage').mockImplementation(async (id, message, referrer, options) => {
        if (options?.session) return original(id, message, referrer, options)
        return pushes()
      })
      vi.spyOn(bot, 'sendPrivateMessage').mockImplementation(pushes)
      const group = app.mock.client('alice', 'group-a'), direct = app.mock.client('alice')
      expect(await group.receive('重置订阅开启')).toEqual(['订阅成功，当前会话将接收重置预告和已执行重置提醒。推送语言：简体中文。'])
      expect(await direct.receive('reset-subscribe')).toEqual(['Subscription successful. This conversation will receive announced-reset and executed-reset alerts. Notification language: English.'])
      const store = new KoishiStore(app), subscription = (await store.subscriptions())[0]!
      await store.enqueue({ id: 'upgrade-legacy-test', subscriptionId: subscription.id, generation: subscription.generation,
        eventKey: 'test:legacy:reset', kind: 'reset', content: 'legacy diagnostic', payload: { type: 'test', kind: 'reset', at: NOW },
        createdAt: NOW, expiresAt: NOW + 300_000, retryAt: 0, attempts: 0, sentAt: 0 })
      await vi.advanceTimersByTimeAsync(6000)
      expect(http).toHaveBeenCalledTimes(2)
      expect(pushes).not.toHaveBeenCalled()
      expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
      expect(await group.receive('重置订阅关闭')).toEqual(['取消成功，已停止当前会话的重置推送。'])
      expect(await direct.receive('reset-unsubscribe')).toEqual(['Cancellation successful. Reset notifications for this conversation have stopped.'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(http).toHaveBeenCalledTimes(2)
      expect(pushes).not.toHaveBeenCalled()
    } finally {
      await app.stop()
      apps.splice(apps.indexOf(app), 1)
      vi.useRealTimers()
    }
  })

  it('orders cancellation and send submission even when the membership query returns an old snapshot', async () => {
    const { app, monitor, store, send } = await setup()
    const group = app.mock.client('alice', 'group-a')
    await group.receive('重置订阅开启')
    await enqueueResetFixtures(store, (await store.subscriptions())[0]!)
    const order: string[] = []
    send.mockImplementation(async () => { order.push('send') })
    let read!: () => void, release!: () => void
    const snapshotRead = new Promise<void>(resolve => { read = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const subscription = store.subscription.bind(store)
    vi.spyOn(store, 'subscription').mockImplementationOnce(async id => {
      const snapshot = await subscription(id)
      read()
      await held
      return snapshot
    })
    const draining = monitor.drain()
    await snapshotRead
    const cancelling = group.receive('重置订阅关闭').then(() => { order.push('cancelled') })
    await new Promise<void>(resolve => setImmediate(resolve))
    release()
    await Promise.all([draining, cancelling])
    expect(order).toContain('cancelled')
    expect(order.slice(order.indexOf('cancelled') + 1)).not.toContain('send')
    expect(await store.subscriptions()).toHaveLength(0)
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
  })

  it('retains an unfinished API marker in the real database when saving Retry-After fails', async () => {
    const { app, store, clock } = await setup()
    const save = store.saveApiState.bind(store)
    let writes = 0
    vi.spyOn(store, 'saveApiState').mockImplementation(async value => {
      if (++writes > 1) throw new Error('response write failed')
      await save(value)
    })
    const transport = vi.fn<Transport>(async () => ({ status: 429, headers: new Headers({ 'retry-after': '3600' }), body: {} }))
    const options = { clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: store }
    await expect(new CodexApi(transport, options).status()).rejects.toThrow('response write failed')
    const restored = new KoishiStore(app)
    await expect(new CodexApi(transport, { ...options, stateStore: restored }).status()).rejects.toThrow('未完成')
    expect(transport).toHaveBeenCalledTimes(1)
    expect(await restored.apiState()).toMatchObject({ requestPending: true })
  })

  it('flushes the known cooldown on a polling wake while upstream calls remain paused', async () => {
    const app = new App({ prefix: '' })
    apps.push(app)
    app.plugin(Memory)
    app.plugin(Mock)
    const http = vi.fn(async () => ({ status: 429, headers: new Headers({ 'retry-after': '3600' }), data: '{}' }))
    app.http = http as unknown as typeof app.http
    app.plugin(plugin, { pollIntervalMs: 60_000 })
    await app.start()
    configureOneBotMock(app)
    await app.mock.initUser('alice', 1)
    await app.mock.initChannel('group-a')
    const upsert = app.database.upsert.bind(app.database)
    let failed = false
    vi.spyOn(app.database, 'upsert').mockImplementation(async (table, rows, keys) => {
      if (table === 'codex_reset_api_state' && rows[0]?.requestPending === false && !failed) {
        failed = true
        throw new Error('temporary response write failure')
      }
      return upsert(table, rows, keys)
    })
    const group = app.mock.client('alice', 'group-a')
    await group.receive('重置订阅开启')
    const store = new KoishiStore(app)
    await vi.waitFor(() => expect(failed).toBe(true), { timeout: 3000 })
    expect((await store.apiState())?.requestPending).toBe(true)
    // Repeating subscribe wakes the normal cycle without changing this subscription.
    await group.receive('重置订阅开启')
    await vi.waitFor(async () => {
      expect(await store.apiState()).toMatchObject({ requestPending: false, failures: 1 })
    }, { timeout: 3000 })
    expect((await store.apiState())!.blockedUntil).toBeGreaterThan(Date.now() + 3500_000)
    expect(http).toHaveBeenCalledTimes(1)
  }, 10_000)

  it('deduplicates committed deliveries when saving baseline progress fails afterwards', async () => {
    const { app, monitor, api, state, store, send, clock } = await setup()
    state.current = status()
    await app.mock.client('alice', 'group-a').receive('重置订阅开启')
    clock.advance(3000)
    const middle = reset({ id: 'middle', announced_at: new Date(NOW + 1000).toISOString() })
    const latest = reset({ id: 'latest', announced_at: new Date(NOW + 2000).toISOString() })
    state.current = status({ latest_reset: latest })
    api.history.mockResolvedValue({ data: [middle, latest], pagination: { has_more: false, next_cursor: null } })
    vi.spyOn(store, 'saveSubscription').mockRejectedValueOnce(new Error('progress write failed'))
    await expect(monitor.poll()).rejects.toThrow('progress write failed')
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(2)
    expect((await store.subscriptions())[0]?.baselined).toBe(false)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(2)
    const restarted = new Monitor(new KoishiStore(app), api, send, {
      clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn(),
    })
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect((await store.subscriptions())[0]?.baselined).toBe(true)
  })

  it('keeps delivered announcements deduplicated while a new target gets their updated details', async () => {
    const { app, monitor, state, send, store } = await setup()
    await app.mock.client('alice', 'group-a').receive('重置订阅开启')
    await monitor.poll()
    const delivered = (await app.database.get('codex_reset_delivery', {}))[0]!
    const scheduledAt = NOW + 7200_000
    state.current = status({ scheduled_reset: scheduled({ scheduled_for: new Date(scheduledAt).toISOString(), text: 'revised announcement details' }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect((await app.database.get('codex_reset_delivery', { id: delivered.id }))[0]).toEqual(delivered)
    await app.mock.client('alice', 'group-b').receive('重置订阅开启')
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1]).toBe(formatScheduled(state.current.data.scheduled_reset!))
    expect(send.mock.calls[1]?.[1]).not.toBe(send.mock.calls[0]?.[1])
    expect((await app.database.get('codex_reset_delivery', {})).find(row => row.id !== delivered.id)?.payload?.scheduled?.scheduled_for).toBe(new Date(scheduledAt).toISOString())
  })

  it.each(['middle', 'latest'])('recovers a new target after the %s catch-up enqueue fails', async failedId => {
    const { app, monitor, api, state, store, send, clock } = await setup()
    state.current = status()
    await app.mock.client('alice', 'group-a').receive('重置订阅开启')
    await monitor.poll()
    let started!: () => void, release!: () => void
    const inFlight = new Promise<void>(resolve => { started = resolve })
    api.status.mockImplementationOnce(async () => {
      started()
      await new Promise<void>(resolve => { release = resolve })
      return state.current
    })
    const polling = monitor.poll()
    await inFlight
    clock.advance(1000)
    await app.mock.client('alice', 'group-b').receive('重置订阅开启')
    const middle = reset({ id: 'middle', text: 'middle-event', announced_at: new Date(NOW + 60_000).toISOString() })
    const latest = reset({ id: 'latest', text: 'latest-event', announced_at: new Date(NOW + 120_000).toISOString() })
    clock.advance(180_000)
    state.current = status({ latest_reset: latest })
    api.history.mockResolvedValue({ data: [middle, latest], pagination: { has_more: false, next_cursor: null } })
    release()
    await polling
    expect((await store.checkpoint())?.latestResetKey).toBe('reset:regular:latest')
    const groupB = (await store.subscriptions()).find(subscription => subscription.targetId === 'group-b')!
    expect(groupB.baselined).toBe(false)
    const enqueue = store.enqueue.bind(store)
    vi.spyOn(store, 'enqueue').mockImplementation(async delivery => {
      if (delivery.subscriptionId === groupB.id && delivery.eventKey === `reset:regular:${failedId}`) throw new Error('queue write failed')
      await enqueue(delivery)
    })
    await expect(monitor.poll()).rejects.toThrow('queue write failed')
    expect((await store.subscription(groupB.id))?.baselined).toBe(false)
    // The scheduler may drain records already committed before the failure.
    await monitor.drain()
    const restarted = new Monitor(new KoishiStore(app), api, send, {
      clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn(),
    })
    await restarted.poll()
    await restarted.poll()
    const delivered = send.mock.calls.filter(([destination]) => destination.targetId === 'group-b')
    expect(delivered).toHaveLength(2)
    expect(delivered.map(([, message]) => message)).toEqual([formatReset(middle), formatReset(latest)])
    expect((await store.subscription(groupB.id))?.baselined).toBe(true)
  })

  it('refreshes only pending announcement content and scheduled time without resetting retry state', async () => {
    const { app, monitor, store, state, send } = await setup()
    await app.mock.client('alice', 'group-a').receive('重置订阅开启')
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    const before = (await app.database.get('codex_reset_delivery', {}))[0]!
    const scheduledAt = NOW + 600_000
    state.current = status({ scheduled_reset: scheduled({ scheduled_for: new Date(scheduledAt).toISOString(), text: 'updated announcement details' }) })
    await monitor.poll()
    const after = (await app.database.get('codex_reset_delivery', {}))[0]!
    expect(after.expiresAt).toBe(0)
    expect(after.payload?.scheduled?.scheduled_for).toBe(new Date(scheduledAt).toISOString())
    expect(after.content).toBe(formatScheduled(state.current.data.scheduled_reset!))
    expect(after.content).not.toBe(before.content)
    expect(after.payload?.scheduled?.text).toBe('updated announcement details')
    expect(after).toMatchObject({ id: before.id, createdAt: before.createdAt, retryAt: before.retryAt, attempts: before.attempts, sentAt: 0 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(await store.subscriptions()).toHaveLength(1)
  })

  it('persists scheduled execution tracking in the database and catches up after monitor reload', async () => {
    const { app, monitor, store, state, api, send, clock } = await setup()
    const scheduled = { ...reset({ id: 'scheduled' }), status: 'scheduled' as const, scheduled_for: null }
    state.current = status({ scheduled_reset: scheduled })
    await app.mock.client('alice', 'group-a').receive('重置订阅开启')
    await monitor.poll()
    expect((await app.database.get('codex_reset_subscription', {}))[0]?.pendingResets).toEqual([
      { key: 'reset:regular:scheduled', announcedAt: scheduled.announced_at },
    ])
    send.mockClear()
    clock.advance(600_000)
    const newer = reset({ id: 'newer', announced_at: new Date(clock.now()).toISOString() })
    state.current = status({ latest_reset: newer })
    api.history.mockResolvedValueOnce({ data: [reset({ id: scheduled.id }), newer], pagination: { has_more: false, next_cursor: null } })
    const restarted = new Monitor(new KoishiStore(app), api, send, {
      clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn(),
    })
    await restarted.poll()
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect((await store.subscriptions())[0]?.pendingResets).toEqual([])
  })

  it('restores a stored API cooldown through a new KoishiStore instance', async () => {
    const { app, clock } = await setup()
    const transport = vi.fn<Transport>(async () => ({
      status: 429, headers: new Headers({ 'retry-after': '3600' }), body: { detail: 'Rate limited' },
    }))
    const first = new CodexApi(transport, {
      clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: new KoishiStore(app),
    })
    await expect(first.status()).rejects.toBeInstanceOf(ApiError)
    const rows = await app.database.get('codex_reset_api_state', {})
    expect(rows).toHaveLength(1)
    expect(rows[0]?.blockedUntil).toBe(clock.now() + 3600_000)
    const reloaded = new CodexApi(transport, {
      clock, cacheMs: 60_000, signal: new AbortController().signal, stateStore: new KoishiStore(app),
    })
    await expect(reloaded.status()).rejects.toBeInstanceOf(ApiError)
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('deletes withdrawn announcement retries but preserves unrelated reset messages', async () => {
    const { app, monitor, state, send, store } = await setup()
    await app.mock.client('alice', 'group-a').receive('重置订阅开启')
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(1)
    await enqueueResetFixtures(store, (await store.subscriptions())[0]!)
    state.current = status({ scheduled_reset: null })
    await monitor.poll()
    const deliveries = await app.database.get('codex_reset_delivery', {})
    expect(deliveries).toHaveLength(2)
    expect(deliveries.every(delivery => delivery.eventKey.startsWith('reset:'))).toBe(true)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('refreshes the API before retrying announcements in the full polling cycle', async () => {
    vi.useFakeTimers({ now: NOW })
    vi.spyOn(require('../lib/util').clock, 'sleep').mockImplementation(ms => new Promise(resolve => setTimeout(resolve, ms)))
    const app = new App({ prefix: '' })
    apps.push(app)
    try {
      app.plugin(Memory)
      app.plugin(Mock)
      let snapshot = status({ scheduled_reset: scheduled() })
      const http = vi.fn(async (url: string) => apiHttpResponse(url, snapshot))
      app.http = http as unknown as typeof app.http
      app.plugin(plugin, { pollIntervalMs: 60_000 })
      await app.start()
    configureOneBotMock(app)
      await vi.advanceTimersByTimeAsync(0)
      await new KoishiStore(app).saveSubscription({
        ...target('group-a', 'channel', '514'), generation: 'polling-fixture', subscribedAt: Date.now(),
        baselined: false, baselineResetKey: '',
      })
      const activeSend = vi.spyOn(app.bots[0]!, 'sendMessage')
        .mockRejectedValueOnce(new Error('bot offline')).mockResolvedValue(['message-id'])
      await vi.advanceTimersByTimeAsync(65_000)
      expect(activeSend).toHaveBeenCalledTimes(1)
      expect(await app.database.get('codex_reset_delivery', { sentAt: 0 })).toHaveLength(1)
      snapshot = status({ scheduled_reset: null })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(http).toHaveBeenCalledTimes(3)
      expect(activeSend).toHaveBeenCalledTimes(1)
      expect(await app.database.get('codex_reset_delivery', { sentAt: 0 })).toHaveLength(0)
    } finally {
      await app.stop()
      apps.splice(apps.indexOf(app), 1)
      vi.useRealTimers()
    }
  })

  it('registers only the current group and preserves it for another group member', async () => {
    const { app, monitor, store, send } = await setup()
    const group = app.mock.client('alice', 'group-a')
    expect(await group.receive('重置订阅开启')).toEqual([expect.stringContaining('订阅成功')])
    expect(await app.mock.client('bob', 'group-a').receive('重置订阅开启')).toEqual([expect.stringContaining('无需重复订阅')])
    expect(await store.subscriptions()).toHaveLength(1)
    expect((await store.subscriptions())[0]?.targetId).toBe('group-a')
    expect(await app.mock.client('alice', 'group-b').receive('重置状态')).toEqual([expect.stringContaining('当前会话未订阅')])
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps private and group subscriptions separate and cancellation affects only its conversation', async () => {
    const { app, store } = await setup()
    const group = app.mock.client('alice', 'group-a')
    const direct = app.mock.client('alice')
    await group.receive('重置订阅开启')
    await direct.receive('重置订阅开启')
    const subscriptions = await store.subscriptions()
    expect(subscriptions).toHaveLength(2)
    expect(subscriptions.find(subscription => subscription.type === 'private')?.targetId).toBe('alice')
    expect(await direct.receive('重置订阅关闭')).toEqual(['取消成功，已停止当前会话的重置推送。'])
    expect(await store.subscriptions()).toHaveLength(1)
    expect((await store.subscriptions())[0]?.targetId).toBe('group-a')
  })

  it('does not subscribe a conversation when it only queries status', async () => {
    const { app, store, monitor, send } = await setup()
    const replies = await app.mock.client('alice').receive('重置状态')
    expect(replies[0]).toContain('Codex 重置状态')
    expect(await store.subscriptions()).toHaveLength(0)
    await monitor.poll()
    expect(send).not.toHaveBeenCalled()
  })

  it('supports namespaced commands and retains delivered records across monitor recreation', async () => {
    const { app, store, monitor, api, send } = await setup()
    expect((await app.mock.client('alice').receive('codex-reset.subscribe'))[0]).toContain('Subscription successful.')
    await monitor.poll()
    const restarted = new Monitor(new KoishiStore(app), api, send, {
      clock: makeClock(), sendDelayMs: 1000,
      signal: new AbortController().signal, report: vi.fn(),
    })
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect((await app.database.get('codex_reset_delivery', {}))[0]?.sentAt).toBeGreaterThan(0)
    expect(await store.subscriptions()).toHaveLength(1)
  })

  it('cleans queued delivery records when the command cancels a subscription', async () => {
    const { app, monitor, send } = await setup()
    const group = app.mock.client('alice', 'group-a')
    await group.receive('重置订阅开启')
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(1)
    await group.receive('重置订阅关闭')
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
  })

  it('does not interpret external text as Koishi message elements', () => {
    const text = 'prediction <at type="all"/> & <img src="https://example.com/a.png"/>'
    const encoded = h.text(text).toString()
    expect(encoded).not.toContain('<at')
    expect(h.parse(encoded).every(element => element.type === 'text')).toBe(true)
    expect(targetFromSession(undefined)).toBeUndefined()
  })

  it('ignores obsolete timeZone settings and routes both notification kinds through the matching bot APIs', async () => {
    const app = new App({ prefix: '' })
    apps.push(app)
    app.plugin(Memory)
    app.plugin(Mock)
    let snapshot: StatusResponse | undefined
    const http = vi.fn(async (url: string) => {
      if (!snapshot) {
        const now = Date.now()
        snapshot = status({
          latest_reset: {
            id: 'full-plugin-reset', reset_type: 'regular', announced_at: new Date(now).toISOString(),
            text: '<at type="all"/>', source: { type: 'observed' },
          },
          scheduled_reset: scheduled({ scheduled_for: new Date(now + 3600_000).toISOString() }),
        })
      }
      return {
        status: 200, headers: new Headers({ etag: 'W/"fixture"' }),
        data: JSON.stringify(url.includes('/resets?')
          ? { data: [snapshot.data.latest_reset], pagination: { has_more: false, next_cursor: null } }
          : snapshot),
      }
    })
    app.http = http as unknown as typeof app.http
    app.plugin(plugin, { pollIntervalMs: 60_000, timeZone: 'obsolete/invalid-zone' })
    await app.start()
    configureOneBotMock(app)
    await app.mock.initUser('alice', 1)
    await app.mock.initChannel('group-a')
    await app.mock.initChannel('group-b')
    expect(http).not.toHaveBeenCalled()

    const bot = app.bots[0]!
    const original = bot.sendMessage.bind(bot)
    const pushes: { type: string; id: string; message: string }[] = []
    vi.spyOn(bot, 'sendMessage').mockImplementation(async (id, message, referrer, options) => {
      if (options?.session) return original(id, message, referrer, options)
      pushes.push({ type: 'channel', id, message: h.normalize(message).map(element => element.toString()).join('') })
      return ['group-message-id']
    })
    vi.spyOn(bot, 'sendPrivateMessage').mockImplementation(async (id, message) => {
      pushes.push({ type: 'private', id, message: h.normalize(message).map(element => element.toString()).join('') })
      return ['private-message-id']
    })
    await app.mock.client('alice', 'group-a').receive('重置订阅开启')
    await app.mock.client('alice').receive('重置订阅开启')
    await vi.waitFor(() => expect(pushes).toHaveLength(4), { timeout: 15_000, interval: 25 })
    expect(http).toHaveBeenCalledTimes(2)
    expect(pushes.filter(push => push.type === 'channel').map(push => push.id)).toEqual(['group-a', 'group-a'])
    expect(pushes.filter(push => push.type === 'private').map(push => push.id)).toEqual(['alice', 'alice'])
    expect(pushes.some(push => push.message.includes('【Codex 重置预告】'))).toBe(true)
    expect(pushes.some(push => push.message.includes('【Codex 已执行重置】'))).toBe(true)
    expect(pushes.every(push => !push.message.includes('<at'))).toBe(true)
    expect(pushes.every(push => push.message.includes('(UTC+08:00)'))).toBe(true)
  }, 20_000)
})
