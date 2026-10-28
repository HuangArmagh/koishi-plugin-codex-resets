import { createRequire } from 'node:module'
import { describe, it, expect, vi } from 'vitest'
import { Monitor, resetKey } from '../src/monitor'
import { enqueueResetFixtures, makeApi, makeClock, MemoryStore, NOW, reset, scheduled, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Mock = require('@koishijs/plugin-mock').default
const Memory = require('@minatojs/driver-memory').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { registerCommands, defaults } = plugin
const { commandIds } = require('../lib/commands') as typeof import('../src/commands')
const { defineModels, KoishiStore } = require('../lib/store') as typeof import('../src/store')

function setup() {
  const store = new MemoryStore(), clock = makeClock(), { api, state } = makeApi()
  const send = vi.fn(async (_target: unknown, _content: string) => {})
  const options = { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() }
  const monitor = new Monitor(store, api, send, options)
  return { store, clock, api, state, send, options, monitor }
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

describe('announcement and native-command lifecycle regressions', () => {
  it('persists historical execution evidence independently of subscriptions, deliveries and the current checkpoint', async () => {
    const { app, store, close } = await databaseSetup()
    try {
      const { api, state, clock, send, options } = setup()
      const monitor = new Monitor(store, api, send, options)
      await monitor.subscribe(target())
      await monitor.poll()
      clock.advance(60_000)
      const announcement = scheduled()
      const executed = reset({ ...announcement, announced_at: new Date(NOW + 1000).toISOString() })
      const latest = reset({ id: 'newer', announced_at: new Date(NOW + 2000).toISOString() })
      state.current = status({ latest_reset: latest, scheduled_reset: announcement })
      api.history.mockResolvedValue({ data: [executed, latest], pagination: { has_more: false, next_cursor: null } })
      await monitor.poll()
      expect(send).toHaveBeenCalledTimes(2)
      expect(await store.hasExecution(resetKey(executed))).toBe(true)
      await monitor.unsubscribe(target())
      expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
      expect((await store.checkpoint())?.latestResetKey).toBe(resetKey(latest))
      const restoredStore = new KoishiStore(app)
      const restarted = new Monitor(restoredStore, api, send, options)
      send.mockClear()
      await restarted.subscribe(target('new-group'))
      await restarted.poll()
      expect(send).not.toHaveBeenCalled()
      expect(await restoredStore.hasExecution(resetKey(executed))).toBe(true)
    } finally { await close() }
  })

  it.each(['sent', 'pending', 'baseline', 'checkpoint'] as const)('restores confirmed executions from legacy %s records without treating forecasts as execution', async origin => {
    const { app, store, close } = await databaseSetup()
    try {
      const key = resetKey(reset({ id: 'confirmed-before-upgrade' }))
      if (origin === 'baseline') await app.database.create('codex_reset_subscription', {
        ...target(), generation: 'legacy', subscribedAt: NOW, baselined: true, baselineResetKey: key,
      })
      if (origin === 'checkpoint') await app.database.create('codex_reset_state', {
        id: 'global', snapshot: { latestResetKey: key, latestResetAt: reset().announced_at, checkedAt: NOW },
      })
      const delivery = { subscriptionId: target().id, generation: 'legacy', content: 'legacy notification',
        createdAt: NOW, expiresAt: 0, retryAt: NOW, attempts: 1, sentAt: origin === 'sent' ? NOW : 0 }
      if (origin === 'sent' || origin === 'pending') await app.database.create('codex_reset_delivery', {
        ...delivery, id: 'real-reset', eventKey: key, kind: 'reset', payload: null,
      })
      for (const type of ['watch', 'test', 'scheduled'] as const) await app.database.create('codex_reset_delivery', {
        ...delivery, id: type, eventKey: 'reset:regular:' + type, kind: type === 'scheduled' ? 'scheduled' : 'reset', payload: { type },
      })
      expect(await store.hasExecution(key)).toBe(true)
      for (const type of ['watch', 'test', 'scheduled']) expect(await store.hasExecution('reset:regular:' + type)).toBe(false)
      expect(await new KoishiStore(app).hasExecution(key)).toBe(true)
      expect(await app.database.get('codex_reset_execution', {})).toHaveLength(1)
    } finally { await close() }
  })

  it('gates cancellation while legacy execution evidence cannot be saved and retries migration safely', async () => {
    const { app, store, close } = await databaseSetup()
    try {
      const key = resetKey(reset({ id: 'legacy-execution' }))
      await app.database.create('codex_reset_subscription', {
        ...target(), generation: 'legacy', subscribedAt: NOW, baselined: true, baselineResetKey: key,
      })
      const write = app.database.upsert.bind(app.database)
      let fail = true
      vi.spyOn(app.database, 'upsert').mockImplementation(async (table, ...args) => {
        if (table === 'codex_reset_execution' && fail) { fail = false; throw new Error('migration write failed') }
        return write(table, ...args)
      })
      await expect(store.deleteSubscription(target().id)).rejects.toThrow('migration write failed')
      expect(await app.database.get('codex_reset_subscription', {})).toHaveLength(1)
      await store.deleteSubscription(target().id)
      expect(await app.database.get('codex_reset_subscription', {})).toHaveLength(0)
      expect(await new KoishiStore(app).hasExecution(key)).toBe(true)
    } finally { await close() }
  })

  it('respects disabled canonical aliases in native Discord interactions', async () => {
    const platform = 'discord'
    const app = new App({ prefix: '!', prefixMode: 'strict' })
    app.plugin(Memory)
    const mock = app.plugin(Mock)
    const { api } = makeApi()
    let store!: InstanceType<typeof KoishiStore>
    app.plugin({ inject: ['database'], apply(ctx) {
      defineModels(ctx)
      store = new KoishiStore(ctx)
      const monitor = new Monitor(store, api, async () => {}, { clock: makeClock(), sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
      registerCommands(ctx, monitor, api, vi.fn(), defaults)
    } })
    await app.start()
    try {
      const bot = app.bots[0]!
      bot.platform = platform
      await app.database.createUser(platform, '200', { authority: 0 })
      const client = app.mock.client('200')
      client.event.platform = platform
      const name = commandIds.subscribe
      app.$commander.get(name)!._aliases[name]!.filter = false
      expect(await client.receive('/' + name)).toEqual([])
      expect(await store.subscriptions()).toHaveLength(0)
      const session = app.mock.session({ ...client.event, type: 'interaction/command', argv: { name, arguments: [], options: {} } })
      let sent!: (content: unknown) => void
      const response = new Promise(resolve => { sent = resolve })
      vi.spyOn(bot, 'sendMessage').mockImplementation(async (_id, content) => { sent(content); return ['reply-id'] })
      await app.parallel('interaction/command', session)
      const reply = await response
      expect(String(reply)).toBe('Insufficient permissions.')
      expect(await store.subscriptions()).toHaveLength(0)
    } finally {
      await mock.dispose()
      await app.stop()
    }
  })

  it.each([false, true])('does not resurrect an announcement after historical execution evidence; reload=%s', async reload => {
    const context = setup()
    const { monitor, state, api, clock, send, store, options } = context
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    const announcement = scheduled()
    const executed = reset({ ...announcement, announced_at: new Date(NOW + 1000).toISOString() })
    const latest = reset({ id: 'newer', announced_at: new Date(NOW + 2000).toISOString() })
    state.current = status({ latest_reset: latest, scheduled_reset: announcement })
    api.history.mockResolvedValue({ data: [executed, latest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    expect(send.mock.calls.every(([, message]) => message.startsWith('【Codex 已执行重置】'))).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    send.mockClear()
    clock.advance(60_000)
    await (reload ? new Monitor(store, api, send, options) : monitor).poll()
    expect(send).not.toHaveBeenCalled()
  })

  it('retains execution evidence after cancellation and does not announce it to new subscribers', async () => {
    const { monitor, state, api, clock, send, store, options } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    clock.advance(60_000)
    const announcement = scheduled()
    const executed = reset({ ...announcement, announced_at: new Date(NOW + 1000).toISOString() })
    const latest = reset({ id: 'newer', announced_at: new Date(NOW + 2000).toISOString() })
    state.current = status({ latest_reset: latest, scheduled_reset: announcement })
    api.history.mockResolvedValue({ data: [executed, latest], pagination: { has_more: false, next_cursor: null } })
    await monitor.poll()
    await monitor.unsubscribe(target())
    expect(store.deliveries.size).toBe(0)
    expect(await store.hasExecution(resetKey(executed))).toBe(true)
    send.mockClear()
    const restarted = new Monitor(store, api, send, options)
    await restarted.subscribe(target())
    await restarted.subscribe(target('new-group'))
    await restarted.poll()
    expect(send).not.toHaveBeenCalled()
    state.current = status({ latest_reset: latest, scheduled_reset: scheduled({ id: executed.id, reset_type: 'banked' }) })
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(([, message]) => message.includes('储备重置'))).toBe(true)
  })

  it('keeps evidence and catch-up progress retryable after an execution-evidence write fails', async () => {
    const { monitor, state, api, clock, send, store } = setup()
    await monitor.subscribe(target())
    await monitor.poll()
    const checkpoint = await store.checkpoint()
    clock.advance(60_000)
    const announcement = scheduled()
    const executed = reset({ ...announcement, announced_at: new Date(NOW + 1000).toISOString() })
    const latest = reset({ id: 'newer', announced_at: new Date(NOW + 2000).toISOString() })
    state.current = status({ latest_reset: latest, scheduled_reset: announcement })
    api.history.mockResolvedValue({ data: [executed, latest], pagination: { has_more: false, next_cursor: null } })
    vi.spyOn(store, 'saveExecutions').mockRejectedValueOnce(new Error('evidence write failed'))
    await expect(monitor.poll()).rejects.toThrow('evidence write failed')
    await monitor.drain()
    expect(send).not.toHaveBeenCalled()
    expect(await store.checkpoint()).toEqual(checkpoint)
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(([, message]) => message.startsWith('【Codex 已执行重置】'))).toBe(true)
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('holds concurrent announcement retries until history can invalidate their execution', async () => {
    const { monitor, state, api, clock, send } = setup()
    state.current = status({ scheduled_reset: scheduled() })
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    clock.advance(60_000)
    const latest = reset({ id: 'newer', announced_at: new Date(NOW + 2000).toISOString() })
    state.current = status({ latest_reset: latest, scheduled_reset: scheduled() })
    let release!: (value: Awaited<ReturnType<typeof api.history>>) => void, started!: () => void
    const historyStarted = new Promise<void>(resolve => { started = resolve })
    api.history.mockImplementationOnce(async () => { started(); return new Promise(resolve => { release = resolve }) })
    const polling = monitor.poll()
    await historyStarted
    try {
      await monitor.drain()
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      release({ data: [reset({ ...scheduled() }), latest], pagination: { has_more: false, next_cursor: null } })
      await polling
    }
    expect(send.mock.calls.slice(1).every(([, message]) => message.startsWith('【Codex 已执行重置】'))).toBe(true)
  })

  it.each(['active', 'withdrawn', 'executed'] as const)('resumes paused announcements correctly when the next snapshot is %s', async outcome => {
    const { monitor, state, api, clock, send, store } = setup()
    state.current = status({ scheduled_reset: scheduled() })
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    clock.advance(60_000)
    await enqueueResetFixtures(store, target(), 1, clock.now())
    api.status.mockRejectedValueOnce(new Error('API unavailable'))
    await expect(monitor.poll()).rejects.toThrow('API unavailable')
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]?.[1]).toContain('Fixture')
    const queued = [...store.deliveries.values()].find(row => row.kind === 'scheduled')!
    expect(queued).toMatchObject({ attempts: 1, sentAt: 0 })
    const retryAt = queued.retryAt
    await monitor.drain()
    expect(queued.retryAt).toBe(retryAt)
    if (outcome === 'withdrawn') state.current = status()
    if (outcome === 'executed') state.current = status({ latest_reset: reset({ ...scheduled() }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(outcome === 'withdrawn' ? 2 : 3)
    if (outcome !== 'withdrawn') expect(send.mock.calls[2]?.[1]).toContain(outcome === 'active' ? '重置预告' : '已执行重置')
  })

  it('holds failed announcement retries when a subsequent status refresh fails', async () => {
    const { monitor, state, api, clock, send } = setup()
    state.current = status({ scheduled_reset: scheduled() })
    await monitor.subscribe(target())
    send.mockRejectedValueOnce(new Error('adapter offline'))
    await monitor.poll()
    send.mockClear()
    clock.advance(60_000)
    state.current = status({ scheduled_reset: null })
    api.status.mockRejectedValueOnce(new Error('status unavailable'))
    await expect(monitor.poll()).rejects.toThrow('status unavailable')
    // apply() drains after polling errors as well.
    await monitor.drain()
    expect(send).not.toHaveBeenCalled()
  })

  it('holds announcement retries through HTTP backoff and resumes only after a successful refresh', async () => {
    vi.useFakeTimers({ now: NOW })
    const app = new App({ prefix: '' })
    app.plugin(Memory)
    const mock = app.plugin(Mock)
    let failStatus = false
    app.http = vi.fn(async () => failStatus
      ? { status: 503, headers: new Headers({ 'Retry-After': '180' }), data: '{}' }
      : { status: 200, headers: new Headers(), data: JSON.stringify(status({ scheduled_reset: scheduled() })) }) as unknown as typeof app.http
    app.plugin(plugin, { pollIntervalMs: 60_000 })
    await app.start()
    try {
      const bot = app.bots[0]!
      bot.platform = 'onebot'
      await vi.advanceTimersByTimeAsync(0)
      await new KoishiStore(app).saveSubscription({ ...target('group-a', 'channel', bot.selfId), locale: 'zh-CN', generation: 'review', subscribedAt: NOW, baselined: false, baselineResetKey: '' })
      const store = new KoishiStore(app)
      const send = vi.spyOn(bot, 'sendMessage').mockRejectedValueOnce(new Error('adapter offline')).mockResolvedValue(['message-id'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).toHaveBeenCalledTimes(1)
      failStatus = true
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).toHaveBeenCalledTimes(1)
      await enqueueResetFixtures(store, target('group-a', 'channel', bot.selfId), 1, Date.now())
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).toHaveBeenCalledTimes(2)
      expect(vi.mocked(app.http)).toHaveBeenCalledTimes(2)
      failStatus = false
      await vi.advanceTimersByTimeAsync(60_000)
      expect(send).toHaveBeenCalledTimes(2)
      // Retry-After: 180 must not shorten the fixed 300-second API cooldown.
      await vi.advanceTimersByTimeAsync(179_999)
      expect(send).toHaveBeenCalledTimes(2)
      expect(vi.mocked(app.http)).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      expect(send).toHaveBeenCalledTimes(3)
      expect(vi.mocked(app.http)).toHaveBeenCalledTimes(3)
    } finally {
      await mock.dispose()
      await app.stop()
      vi.useRealTimers()
    }
  })
})
