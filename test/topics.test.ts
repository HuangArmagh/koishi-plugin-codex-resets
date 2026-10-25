import { createRequire } from 'node:module'
import type { App as KoishiApp, Session } from 'koishi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Delivery, Subscription } from '../src/types'
import { makeApi, makeClock, NOW, reset, status, scheduled } from './helpers'

const require = createRequire(import.meta.url)
const { App, MessageEncoder, Universal } = require('koishi') as typeof import('koishi')
const Mock = require('@koishijs/plugin-mock').default
const Memory = require('@minatojs/driver-memory').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { Monitor } = require('../lib/monitor') as typeof import('../src/monitor')
const { resetKey, scheduledKey } = require('../lib/monitor') as typeof import('../src/monitor')
const { hash } = require('../lib/util') as typeof import('../src/util')
const { KoishiStore, defineModels } = require('../lib/store') as typeof import('../src/store')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

const groupA = '-1001000000001', groupB = '-1001000000002'
function session(app: KoishiApp, guildId = groupA, channelId = '42', direct = false, content?: string, userId = '200'): Session {
  const result = app.bots[0]!.session({
    type: 'interaction/command', platform: 'telegram', user: { id: userId },
    guild: direct ? undefined : { id: guildId },
    channel: { id: channelId, type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT },
  })
  if (content) result.content = content
  return result
}
async function start(app: KoishiApp, mock: { dispose(): unknown }) {
  await app.start()
  const bot = app.bots[0]!
  bot.platform = 'telegram'
  bot.internal = { getChatMember: vi.fn(async ({ user_id }) => ({
    user: { id: user_id }, status: user_id === 200 ? 'administrator' : 'member',
  })) }
  cleanups.push(async () => { bot.platform = 'mock'; await mock.dispose(); await app.stop() })
  return bot
}
async function setup() {
  const app = new App({ prefix: '!', prefixMode: 'strict' })
  app.plugin(Memory)
  const mock = app.plugin(Mock)
  const { api } = makeApi(status({ scheduled_reset: scheduled() })), clock = makeClock()
  const send = vi.fn(async (_target: Subscription, _content: string) => {})
  let store!: InstanceType<typeof KoishiStore>, monitor!: InstanceType<typeof Monitor>
  app.plugin({ inject: ['database'], apply(ctx) {
    defineModels(ctx)
    store = new KoishiStore(ctx)
    monitor = new Monitor(store, api, send, { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
    plugin.registerCommands(ctx, monitor, api, () => {}, plugin.defaults)
  } })
  await start(app, mock)
  return { app, store, monitor, send, api, clock }
}
async function run(app: KoishiApp, action: 'status' | 'subscribe' | 'unsubscribe', guildId = groupA, channelId = '42', content?: string, userId = '200') {
  return (await session(app, guildId, channelId, false, content, userId).execute({
    name: 'codexreset' + action, args: [], options: {},
  }, true)).join('')
}

async function seedLegacyTopic(app: KoishiApp) {
  const destination = plugin.targetFromSession(session(app))!
  const id = hash([destination.platform, destination.selfId, destination.type, destination.targetId])
  const old: Subscription = { ...destination, id, locale: 'ja-JP', generation: 'legacy-generation',
    subscribedAt: NOW - 7200_000, baselined: true, baselineResetKey: '',
    pendingResets: [{ key: 'reset:regular:scheduled', announcedAt: new Date(NOW).toISOString() }] }
  await app.database.create('codex_reset_subscription', old)
  const events = [
    { eventKey: resetKey(reset()), kind: 'reset' as const, payload: { type: 'reset' as const, reset: reset() }, sentAt: NOW - 20_000 },
    { eventKey: scheduledKey(scheduled()), kind: 'scheduled' as const, payload: { type: 'scheduled' as const, scheduled: scheduled() }, sentAt: NOW - 10_000 },
    { eventKey: 'reset:regular:retry', kind: 'reset' as const, payload: { type: 'reset' as const, reset: reset({ id: 'retry', text: 'pending reset' }) }, sentAt: 0 },
  ]
  const deliveries: Delivery[] = []
  for (const event of events) {
    const delivery: Delivery = { ...event, id: hash([id, old.generation, event.eventKey]), subscriptionId: id,
      generation: old.generation, content: 'legacy content', createdAt: NOW - 30_000, expiresAt: 0,
      retryAt: event.sentAt ? 0 : NOW + 30_000, attempts: event.sentAt ? 0 : 3 }
    await app.database.create('codex_reset_delivery', delivery)
    deliveries.push(delivery)
  }
  return { old, destination, deliveries }
}

async function expectMigrated(app: KoishiApp, fixture: Awaited<ReturnType<typeof seedLegacyTopic>>) {
  const { old, destination, deliveries } = fixture
  expect(destination.id).not.toBe(old.id)
  expect(await app.database.get('codex_reset_subscription', {})).toEqual([{ ...old, id: destination.id, baselineExecutionKeys: [] }])
  const actual = await app.database.get('codex_reset_delivery', {})
  expect(actual).toHaveLength(deliveries.length)
  for (const delivery of deliveries) expect(actual).toContainEqual({ ...delivery,
    id: hash([destination.id, delivery.generation, delivery.eventKey]), subscriptionId: destination.id })
}

describe('Telegram topic subscriptions', () => {
  it('isolates status, language, permissions, queued notifications and cancellation across groups with the same topic number', async () => {
    const { app, store, monitor, send } = await setup()
    expect(await run(app, 'subscribe', groupA, '42', '重置订阅开启')).toContain('订阅成功')
    expect(await run(app, 'status', groupB)).toContain('This conversation is not subscribed.')
    expect(await run(app, 'unsubscribe', groupB)).toContain('not subscribed')
    expect(await store.subscriptions()).toHaveLength(1)
    expect(await run(app, 'subscribe', groupB, '42', 'リセット購読')).toContain('購読しました')
    const a = plugin.targetFromSession(session(app, groupA))!, b = plugin.targetFromSession(session(app, groupB))!
    expect(a.id).not.toBe(b.id)
    expect((await store.subscription(a.id))?.locale).toBe('zh-CN')
    expect((await store.subscription(b.id))?.locale).toBe('ja-JP')
    expect(await run(app, 'subscribe', groupB)).toContain('Already subscribed')
    expect((await store.subscription(a.id))?.locale).toBe('zh-CN')
    expect((await store.subscription(b.id))?.locale).toBe('en-US')
    expect(await run(app, 'unsubscribe', groupA, '42', undefined, '201')).toContain('Only the group owner')
    send.mockRejectedValue(new Error('adapter offline'))
    await monitor.poll()
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(2)
    expect(await run(app, 'unsubscribe', groupB)).toContain('Cancellation successful')
    expect(await store.subscriptions()).toHaveLength(1)
    expect((await app.database.get('codex_reset_delivery', {})).map(row => row.subscriptionId)).toEqual([a.id])
    expect(await run(app, 'subscribe', groupA, '43')).toContain('Subscription successful')
    expect(await store.subscriptions()).toHaveLength(2)
  })

  it('keeps different topics, ordinary groups, private chats and bot accounts distinct', async () => {
    const { app } = await setup()
    const first = session(app)
    const otherBot = { platform: 'telegram', selfId: 'other-bot', isDirect: false, guildId: groupA, channelId: '42' } as Session
    const targets = [first, session(app, groupA, '43'), session(app, groupB),
      session(app, groupA, groupA), session(app, groupA, '42', true), otherBot].map(value => plugin.targetFromSession(value)!)
    expect(new Set(targets.map(value => value.id)).size).toBe(targets.length)
    const missingGuild = session(app)
    delete missingGuild.event.guild
    expect(plugin.targetFromSession(missingGuild)).toBeUndefined()
  })

  it('migrates legacy topic subscriptions and sent/retry state without replaying delivered events after reload', async () => {
    const { app, store, api, clock } = await setup()
    const fixture = await seedLegacyTopic(app)
    expect((await store.subscription(fixture.destination.id))?.locale).toBe('ja-JP')
    await expectMigrated(app, fixture)
    expect(await run(app, 'status', groupB)).toContain('This conversation is not subscribed.')
    expect(await run(app, 'unsubscribe', groupB)).toContain('not subscribed')
    const send = vi.fn(async () => {})
    const makeMonitor = () => new Monitor(new KoishiStore(app), api, send, {
      clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn(),
    })
    const monitor = makeMonitor()
    await monitor.poll()
    expect(send).not.toHaveBeenCalled()
    clock.advance(30_000)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toContain('【Codex リセット実行済み】')
    const delivered = (await app.database.get('codex_reset_delivery', { eventKey: 'reset:regular:retry' }))[0]!
    expect(delivered).toMatchObject({ subscriptionId: fixture.destination.id, attempts: 3, sentAt: clock.now() })
    await makeMonitor().poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await run(app, 'unsubscribe')).toContain('Cancellation successful')
    expect(await app.database.get('codex_reset_subscription', {})).toHaveLength(0)
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
  })

  it.each([
    ['create', 'codex_reset_subscription'], ['create', 'codex_reset_delivery'],
    ['remove', 'codex_reset_delivery'], ['remove', 'codex_reset_subscription'],
  ] as const)('retries an interrupted migration at %s %s without partial delivery or duplicate rows', async (operation, table) => {
    const { app, store, monitor, api, send } = await setup()
    const fixture = await seedLegacyTopic(app)
    const original = app.database[operation].bind(app.database)
    let fail = true
    vi.spyOn(app.database, operation).mockImplementation(async (...args: any[]) => {
      if (fail && args[0] === table) throw new Error('migration write unavailable')
      return original(...args as [never, never])
    })
    await expect(monitor.poll()).rejects.toThrow('migration write unavailable')
    await expect(store.pending(NOW + 60_000)).rejects.toThrow('migration write unavailable')
    expect(api.status).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect((await app.database.get('codex_reset_subscription', { id: fixture.old.id }))).toHaveLength(1)
    fail = false
    const reloaded = new KoishiStore(app)
    await Promise.all([reloaded.subscriptions(), reloaded.pending(NOW)])
    await expectMigrated(app, fixture)
    await store.subscriptions() // The original instance can also recover after its failed preparation.
    await expectMigrated(app, fixture)
  })

  it('leaves existing normal Telegram groups, private chats and other platform subscriptions unchanged', async () => {
    const { app, store } = await setup()
    const values = [plugin.targetFromSession(session(app, groupA, groupA))!, plugin.targetFromSession(session(app, '', 'private', true))!,
      { platform: 'onebot', selfId: 'bot-a', type: 'channel' as const, targetId: 'group-a', guildId: 'group-a', id: hash(['onebot', 'bot-a', 'channel', 'group-a']) }]
    const rows = values.map(destination => ({ ...destination, generation: 'unchanged', subscribedAt: NOW, baselined: false, baselineResetKey: '', pendingResets: [], locale: 'en-US' as const }))
    for (const row of rows) await app.database.create('codex_reset_subscription', row)
    expect(await store.subscriptions()).toEqual(rows.map(row => ({ ...row, baselineExecutionKeys: [] })))
    for (const row of rows) expect(row.id).toBe(hash([row.platform, row.selfId, row.type, row.targetId]))
  })

  it('stops on conflicting subscription generations instead of merging unrelated delivery histories', async () => {
    const { app, store } = await setup()
    const { old, destination } = await seedLegacyTopic(app)
    await app.database.create('codex_reset_subscription', { ...old, id: destination.id, generation: 'different-generation' })
    await expect(store.subscriptions()).rejects.toThrow('迁移存在冲突')
    expect(await app.database.get('codex_reset_subscription', {})).toHaveLength(2)
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(3)
  })

  it('passes group and topic routing context through the real MessageEncoder for reset and announcement deliveries', async () => {
    vi.useFakeTimers({ now: NOW })
    const app = new App({ prefix: '!' })
    app.plugin(Memory)
    const mock = app.plugin(Mock)
    const http = vi.fn(async () => ({ status: 200, headers: new Headers(), data: JSON.stringify(status({ scheduled_reset: scheduled() })) }))
    app.http = http as unknown as typeof app.http
    app.plugin(plugin, { pollIntervalMs: 60_000 })
    const bot = await start(app, mock)
    vi.spyOn(require('../lib/util').clock, 'sleep').mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(0)
    const routes: { chat_id: string; message_thread_id?: number; content: string }[] = []
    class TelegramRoutingEncoder extends MessageEncoder {
      payload!: (typeof routes)[number]
      async prepare() {
        // Official TelegramMessageEncoder.prepare(): guild is the chat, channel is the topic.
        this.payload = { chat_id: this.session.guildId || this.channelId, content: '' }
        if (this.session.guildId && this.channelId !== this.session.guildId) this.payload.message_thread_id = +this.channelId
      }
      async visit(element: import('koishi').h) { this.payload.content += element.attrs.content ?? '' }
      async flush() { routes.push(this.payload); this.results.push({ id: 'simulated-' + routes.length }) }
    }
    vi.spyOn(bot, 'sendMessage').mockImplementation(async (channel, content, referrer, options) =>
      (await new TelegramRoutingEncoder(bot, channel, referrer, options).send(content)).map(value => value.id!))
    const privateSend = vi.spyOn(bot, 'sendPrivateMessage').mockResolvedValue(['private-message'])
    const store = new KoishiStore(app)
    for (const [guildId, channelId, direct] of [[groupA, '42', false], [groupB, '42', false], [groupA, '43', false], [groupB, groupB, false], ['', 'private-channel', true]] as const) {
      const current = session(app, guildId, channelId, direct)
      await current.execute({ name: 'codexresetsubscribe', args: [], options: {} }, true)
      const destination = (await store.subscription(plugin.targetFromSession(current)!.id))!
      await store.enqueue({
        id: 'fixture-' + destination.id, subscriptionId: destination.id, generation: destination.generation,
        eventKey: 'reset:regular:fixture', kind: 'reset', content: '', payload: { type: 'reset', reset: reset() },
        createdAt: NOW, expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0,
      })
    }
    await vi.advanceTimersByTimeAsync(15_000)
    expect(http).toHaveBeenCalledTimes(1)
    expect(routes).toHaveLength(8)
    for (const [guild, topic] of [[groupA, 42], [groupB, 42], [groupA, 43], [groupB, undefined]] as const) {
      const matching = routes.filter(route => route.chat_id === guild && route.message_thread_id === topic)
      expect(matching).toHaveLength(2)
      expect(matching.some(route => route.content.includes('[Codex reset announced]'))).toBe(true)
      expect(matching.some(route => route.content.includes('[Codex reset executed]'))).toBe(true)
    }
    expect(privateSend).toHaveBeenCalledTimes(2)
    expect(privateSend.mock.calls.every(call => call[0] === '200')).toBe(true)
    expect((await app.database.get('codex_reset_delivery', {})).every(row => row.sentAt > 0)).toBe(true)
  })
})
