import { createRequire } from 'node:module'
import type { App as KoishiApp, Context } from 'koishi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LanguageSetting } from '../src/locales'
import type { QQGroupManager } from '../src/permissions'
import { makeApi, makeClock, scheduled, status, reset, NOW } from './helpers'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Mock = require('@koishijs/plugin-mock').default
const Memory = require('@minatojs/driver-memory').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { commandIds } = require('../lib/commands') as typeof import('../src/commands')
const { Monitor } = require('../lib/monitor') as typeof import('../src/monitor')
const { KoishiStore, defineModels } = require('../lib/store') as typeof import('../src/store')
const { commandNames, languageNames, locales, text } = require('../lib/locales') as typeof import('../src/locales')
const apps: KoishiApp[] = []
afterEach(async () => { for (const app of apps.splice(0)) await app.stop() })

async function setup(configured = true, locale: LanguageSetting = 'auto') {
  const app = new App({ prefix: '!', prefixMode: 'strict' })
  apps.push(app)
  app.plugin(Memory); app.plugin(Mock)
  const qqGroupManagers: QQGroupManager[] = []
  const { api, state } = makeApi(status())
  const clock = makeClock(), send = vi.fn(async (_target: unknown, _content: string) => {}), wake = vi.fn()
  let store!: InstanceType<typeof KoishiStore>, monitor!: InstanceType<typeof Monitor>
  app.plugin({ inject: ['database'], apply(ctx: Context) {
    defineModels(ctx); store = new KoishiStore(ctx)
    monitor = new Monitor(store, api, send, { clock, sendDelayMs: 1000, locale,
      signal: new AbortController().signal, report: vi.fn() })
    plugin.registerCommands(ctx, monitor, api, wake, { ...plugin.defaults, locale, qqGroupManagers })
  } })
  await app.start()
  const bot = app.bots[0]!
  bot.platform = 'qq'
  bot.getGuildMember = vi.fn(async () => { throw new Error('QQ group member role API is unavailable') })
  await app.database.createUser('qq', 'member-a', { authority: 0 })
  await app.database.createUser('qq', 'member-b', { authority: 5 })
  for (const id of ['group-a', 'group-b']) await app.database.createChannel('qq', id, { assignee: bot.selfId })
  if (configured) qqGroupManagers.push({ selfId: bot.selfId, groupId: 'group-a', userIds: ['member-a'] })
  const client = (userId = 'member-a', groupId?: string) => {
    const result = app.mock.client(userId, groupId)
    // Mirrors official QQ group events: same guild/channel OpenID and no member roles.
    result.event.platform = 'qq'
    return result
  }
  return { app, bot, store, monitor, state, clock, send, wake, client, qqGroupManagers }
}

describe('official QQ authorization through Koishi commands', () => {
  it.each(locales.flatMap((locale, index) => ['', '/', '!'].map(prefix => ({ locale, index, prefix }))))(
    'supports the three commands in $locale with prefix "$prefix" and exact QQ grants', async ({ locale, index, prefix }) => {
      const { store, bot, wake, client, send } = await setup()
      const group = client('member-a', 'group-a'), other = client('member-b', 'group-a')
      const run = (action: keyof typeof commandNames) => prefix + commandNames[action][index]
      expect(await group.receive(run('subscribe'))).toEqual([text(locale, 'subscribed', { language: languageNames[locale] })])
      expect(await store.subscriptions()).toMatchObject([{ platform: 'qq', selfId: bot.selfId,
        targetId: 'group-a', guildId: 'group-a', type: 'channel', locale }])
      const before = await store.subscriptions()
      for (const action of ['subscribe', 'unsubscribe'] as const) {
        expect(await other.receive(run(action))).toEqual([text(locale, 'qqNotAuthorized')])
        expect(await client('member-a', 'group-b').receive(run(action))).toEqual([text(locale, 'qqNotConfigured')])
      }
      expect(await store.subscriptions()).toEqual(before)
      expect((await other.receive(run('status')))[0]).toContain(text(locale, 'statusTitle'))
      expect(await group.receive(run('unsubscribe'))).toEqual([text(locale, 'unsubscribed')])
      expect(await store.subscriptions()).toHaveLength(0)
      expect(wake).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      expect(bot.getGuildMember).not.toHaveBeenCalled()
    },
  )

  it.each(locales)('keeps public status and private commands available with empty grants and forced %s replies', async locale => {
    const { client, store, wake } = await setup(false, locale)
    const group = client('member-b', 'group-a')
    for (const command of ['重置订阅开启', '/重置订阅关闭']) {
      expect(await group.receive(command)).toEqual([text(locale, 'qqNotConfigured')])
    }
    expect((await group.receive('重置状态'))[0]).toContain(text(locale, 'statusTitle'))
    expect(await store.subscriptions()).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
    const direct = client('member-a')
    expect(await direct.receive('重置订阅开启')).toEqual([text(locale, 'subscribed', { language: languageNames[locale] })])
    expect((await direct.receive('重置状态'))[0]).toContain(text(locale, 'statusTitle'))
    expect(await direct.receive('重置订阅关闭')).toEqual([text(locale, 'unsubscribed')])
  })

  it('does not subscribe on configuration alone and routes both notification types only after opt-in', async () => {
    const { monitor, client, store, state, clock, send, qqGroupManagers } = await setup()
    await monitor.poll()
    expect(await store.subscriptions()).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
    await client('member-a', 'group-a').receive('重置订阅开启')
    await monitor.poll()
    state.current = status({ scheduled_reset: scheduled() })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]).toEqual([expect.objectContaining({ platform: 'qq', targetId: 'group-a' }), expect.stringContaining('【Codex 重置预告】')])
    clock.advance(60_000)
    state.current = status({ latest_reset: reset({ id: 'new-reset', announced_at: new Date(NOW + 1000).toISOString() }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1]).toEqual([expect.objectContaining({ platform: 'qq', targetId: 'group-a' }), expect.stringContaining('【Codex 已执行重置】')])
    const before = await store.subscriptions()
    qqGroupManagers[0]!.userIds = ['member-b']
    expect(await client('member-a', 'group-a').receive('reset-subscribe')).toEqual([text('en-US', 'qqNotAuthorized')])
    expect(await client('member-a', 'group-a').receive('重置订阅关闭')).toEqual([text('zh-CN', 'qqNotAuthorized')])
    expect(await store.subscriptions()).toEqual(before)
    await client('member-b', 'group-a').receive('重置订阅关闭')
    expect(await store.subscriptions()).toHaveLength(0)
    state.current = status({ scheduled_reset: scheduled({ id: 'later-announcement' }) })
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('retains alias filters and global Koishi restrictions for authorized QQ members', async () => {
    const { app, client, store } = await setup()
    const subscribe = app.$commander.get(commandIds.subscribe)!
    subscribe._aliases['重置订阅开启']!.filter = false
    const group = client('member-a', 'group-a')
    for (const prefix of ['', '/', '!']) expect(await group.receive(prefix + '重置订阅开启')).toEqual([])
    expect(await store.subscriptions()).toHaveLength(0)
    subscribe.config.permissions = ['authority:4']
    expect(await group.receive('reset-subscribe')).toEqual([text('en-US', 'lowAuthority')])
    expect(await store.subscriptions()).toHaveLength(0)
    subscribe.config.permissions = ['authority:0']
    expect(await group.receive('reset-subscribe')).toEqual([text('en-US', 'subscribed', { language: 'English' })])
  })

  it('rejects routing to a different group even when the guild matches an authorized entry', async () => {
    const { client, store } = await setup()
    const group = client('member-a', 'group-b')
    group.event.guild = { id: 'group-a' }
    expect(await group.receive('重置订阅开启')).toEqual([text('zh-CN', 'roleUnavailable')])
    expect(await store.subscriptions()).toHaveLength(0)
  })

  it.each(locales)('explains unsupported adapters separately in %s', async locale => {
    const { app, client, store } = await setup(false, locale)
    app.bots[0]!.platform = 'unsupported'
    const group = client('member-a', 'group-a')
    group.event.platform = 'unsupported'
    await app.database.createUser('unsupported', 'member-a', { authority: 5 })
    expect(await group.receive('重置订阅开启')).toEqual([text(locale, 'groupUnsupported')])
    expect(await store.subscriptions()).toHaveLength(0)
  })
})

describe('QQ authorization configuration', () => {
  it('provides empty defaults and rejects incomplete or wildcard entries in the Koishi schema', () => {
    expect(plugin.Config({}).qqGroupManagers).toEqual([])
    const entry = { selfId: 'bot-a', groupId: 'group-a', userIds: ['member-a'] }
    expect(plugin.Config({ qqGroupManagers: [entry] }).qqGroupManagers).toEqual([entry])
    for (const row of [{}, { ...entry, selfId: '*' }, { ...entry, groupId: '' },
      { ...entry, userIds: [] }, { ...entry, userIds: ['*'] }, { ...entry, userIds: ['member-a\n'] }]) {
      expect(() => plugin.Config({ qqGroupManagers: [row] } as never)).toThrow()
    }
    expect(() => plugin.apply({} as Context, { qqGroupManagers: [null] } as never)).toThrow('Invalid qqGroupManagers')
  })

  it.each(locales)('localizes the authorization list and its nested fields in %s', locale => {
    const field = plugin.Config.dict!.qqGroupManagers!
    for (const schema of [field, ...Object.values(field.inner!.dict!)]) {
      expect((schema.meta.description as Record<string, string>)[locale]).toBeTruthy()
    }
  })

  it('passes explicit grants through the real plugin entry point', async () => {
    vi.useFakeTimers({ now: NOW })
    const app = new App({ prefix: '' })
    apps.push(app)
    try {
      app.plugin(Memory); app.plugin(Mock)
      const bot = app.bots[0]!
      bot.platform = 'qq'
      const http = vi.fn(async () => ({ status: 200, headers: new Headers(), data: JSON.stringify(status()) }))
      app.http = http as unknown as typeof app.http
      app.plugin(plugin, { qqGroupManagers: [{ selfId: bot.selfId, groupId: 'group-a', userIds: ['member-a'] }] })
      await app.start()
      await vi.advanceTimersByTimeAsync(0)
      await app.database.createUser('qq', 'member-a', { authority: 0 })
      await app.database.createChannel('qq', 'group-a', { assignee: bot.selfId })
      const group = app.mock.client('member-a', 'group-a')
      group.event.platform = 'qq'
      expect(await group.receive('重置订阅开启')).toEqual([text('zh-CN', 'subscribed', { language: '简体中文' })])
      expect(await new KoishiStore(app).subscriptions()).toHaveLength(1)
      expect(await group.receive('重置订阅关闭')).toEqual([text('zh-CN', 'unsubscribed')])
      expect(await new KoishiStore(app).subscriptions()).toHaveLength(0)
    } finally {
      await app.stop()
      apps.splice(apps.indexOf(app), 1)
      vi.useRealTimers()
    }
  })
})
