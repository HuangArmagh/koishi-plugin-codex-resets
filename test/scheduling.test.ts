import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { configureOneBotMock, enqueueResetFixtures, NOW, reset, status, target } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Mock = require('@koishijs/plugin-mock').default
const Memory = require('@minatojs/driver-memory').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { KoishiStore } = require('../lib/store') as typeof import('../src/store')
const { Monitor, resetKey } = require('../lib/monitor') as typeof import('../src/monitor')
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function setup() {
  vi.useFakeTimers({ now: NOW })
  const app = new App({ prefix: '' })
  app.plugin(Memory)
  const mock = app.plugin(Mock)
  const http = vi.fn(async () => ({ status: 200, headers: new Headers(), data: JSON.stringify(status()) }))
  app.http = http as unknown as typeof app.http
  const fork = app.plugin(plugin, { pollIntervalMs: 60_000 })
  cleanups.push(async () => { await mock.dispose(); await app.stop() })
  await app.start()
  const bot = configureOneBotMock(app)
  await app.mock.initUser('subscriber', 0)
  await vi.advanceTimersByTimeAsync(0)
  return { app, bot, http, fork, client: app.mock.client('subscriber'), store: new KoishiStore(app) }
}

describe('subscription wake scheduling', () => {
  it('checks and delivers to another conversation during sustained repeat subscriptions', async () => {
    const { bot, http, client, store } = await setup()
    const destination = target('other-conversation', 'private', bot.selfId)
    await store.saveSubscription({ ...destination, locale: 'zh-CN', generation: 'existing', subscribedAt: NOW,
      baselined: true, baselineResetKey: resetKey(reset()) })
    await enqueueResetFixtures(store, destination, 1)
    const send = vi.spyOn(bot, 'sendPrivateMessage').mockResolvedValue(['sent-id'])
    expect((await client.receive('重置订阅开启')).join('')).toContain('订阅成功')
    for (let index = 0; index < 20; index++) {
      await vi.advanceTimersByTimeAsync(500)
      expect((await client.receive('重置订阅开启')).join('')).toContain('无需重复订阅')
    }
    expect(http).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]![0]).toBe('other-conversation')
    expect(await store.subscriptions()).toHaveLength(2)
    expect((await store.subscription(destination.id))?.generation).toBe('existing')
  })

  it('preserves a periodic check that is due sooner than the subscription wake delay', async () => {
    const { http, client } = await setup()
    await vi.advanceTimersByTimeAsync(59_500)
    await client.receive('重置订阅开启')
    await vi.advanceTimersByTimeAsync(499)
    expect(http).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(http).toHaveBeenCalledTimes(1)
  })

  it('coalesces subscriptions during a running check into one subsequent check', async () => {
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const poll = vi.spyOn(Monitor.prototype, 'poll').mockImplementationOnce(() => pending).mockResolvedValue(undefined)
    const { client } = await setup()
    expect(poll).toHaveBeenCalledTimes(1)
    await client.receive('重置订阅开启')
    await client.receive('重置订阅开启')
    await vi.advanceTimersByTimeAsync(2000)
    expect(poll).toHaveBeenCalledTimes(1)
    finish()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(poll).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(poll).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(poll).toHaveBeenCalledTimes(3)
  })

  it('cancels the pending wake when the plugin is disposed', async () => {
    const { http, client, fork } = await setup()
    await client.receive('重置订阅开启')
    await fork.dispose()
    await vi.advanceTimersByTimeAsync(61_000)
    expect(http).not.toHaveBeenCalled()
  })
})
