import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App as KoishiApp } from 'koishi'
import { configureOneBotMock, makeApi, makeClock, NOW, reset, status, scheduled, watch } from './helpers'
import type { LanguageSetting } from '../src/locales'

const require = createRequire(import.meta.url)
const { App } = require('koishi') as typeof import('koishi')
const Mock = require('@koishijs/plugin-mock').default
const Memory = require('@minatojs/driver-memory').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { commandIds } = require('../lib/commands') as typeof import('../src/commands')
const { Monitor } = require('../lib/monitor') as typeof import('../src/monitor')
const { KoishiStore, defineModels } = require('../lib/store') as typeof import('../src/store')
const { commandNames, languageNames, locales, text } = require('../lib/locales') as typeof import('../src/locales')
const { formatReset, formatScheduled, formatOverview } = require('../lib/format') as typeof import('../src/format')
const apps: KoishiApp[] = []
afterEach(async () => { for (const app of apps.splice(0)) await app.stop() })

const titles = ['[Codex reset announced]', '【Codex 重置预告】', '【Codex 重置預告】', '【Codex リセット予告】', '【Codex 리셋 사전 공지】']
const statusTitles = ['[Codex reset status]', '【Codex 重置状态】', '【Codex 重置狀態】', '【Codex リセット状況】', '【Codex 리셋 상태】']
const resetTitles = ['[Codex reset executed]', '【Codex 已执行重置】', '【Codex 已執行重置】', '【Codex リセット実行済み】', '【Codex 리셋 실행됨】']
const subscribed = ['Subscription successful.', '订阅成功', '訂閱成功', '購読しました。', '구독이 완료되었습니다.']
const cancelled = ['Cancellation successful.', '取消成功', '取消成功', '購読を解除しました。', '구독을 취소했습니다.']
const timeZoneLabels = ['(UTC)', '(UTC+08:00)', '(UTC+08:00)', '(UTC+09:00)', '(UTC+09:00)']

async function setup(locale: LanguageSetting = 'auto', role = 'admin', prefix = '!') {
  const app = new App({ prefix, prefixMode: 'strict' })
  apps.push(app)
  app.plugin(Memory); app.plugin(Mock)
  const clock = makeClock(), { api, state } = makeApi(status({ scheduled_reset: scheduled() }))
  const send = vi.fn(async (_destination: unknown, _content: string) => {}), wake = vi.fn()
  let store!: InstanceType<typeof KoishiStore>, monitor!: InstanceType<typeof Monitor>
  app.plugin({ inject: ['database'], apply(ctx) {
    defineModels(ctx); store = new KoishiStore(ctx)
    monitor = new Monitor(store, api, send, { clock, locale, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
    plugin.registerCommands(ctx, monitor, api, wake, { ...plugin.defaults, locale })
    ctx.command('other').action(() => 'other-plugin')
  } })
  await app.start()
  configureOneBotMock(app, role)
  await app.mock.initUser('alice', 0)
  await app.mock.initUser('operator', 5)
  await app.mock.initChannel('group-a')
  return { app, store, monitor, api, state, clock, send, wake }
}

describe('three commands with five-language support', () => {
  it.each([
    { locale: 'en-US', subscribedCopy: 'This conversation is subscribed to receive reset announcements and executed-reset alerts.\nNotification language: English.',
      unsubscribedCopy: 'This conversation is not subscribed.\nUse reset-subscribe to receive reset announcements and executed-reset alerts.' },
    { locale: 'zh-CN', subscribedCopy: '当前会话已订阅：接收重置预告和已执行重置提醒。\n推送语言：简体中文。',
      unsubscribedCopy: '当前会话未订阅。\n发送「重置订阅开启」接收重置预告和已执行重置提醒。' },
    { locale: 'zh-TW', subscribedCopy: '目前會話已訂閱：接收重置預告與已執行重置通知。\n通知語言：繁體中文。',
      unsubscribedCopy: '目前會話未訂閱。\n傳送「重置訂閱開啟」接收重置預告與已執行重置通知。' },
    { locale: 'ja-JP', subscribedCopy: 'このチャットは購読中です。リセット予告と実行済みリセットの通知を受け取ります。\n通知言語：日本語。',
      unsubscribedCopy: 'このチャットは未購読です。\n「リセット購読」でリセット予告と実行済みリセットの通知を受け取れます。' },
    { locale: 'ko-KR', subscribedCopy: '이 채팅은 구독 중이며 리셋 사전 공지와 실행된 리셋 알림을 받습니다.\n알림 언어: 한국어.',
      unsubscribedCopy: '이 채팅은 구독 중이 아닙니다.\n리셋구독으로 리셋 사전 공지와 실행된 리셋 알림을 받을 수 있습니다.' },
  ] as const)('renders the approved subscription copy in $locale', ({ locale, subscribedCopy, unsubscribedCopy }) => {
    expect(text(locale, 'subscription', { language: languageNames[locale] })).toBe(subscribedCopy)
    expect(text(locale, 'notSubscribed')).toBe(unsubscribedCopy)
    expect(formatOverview(status(), [], locale, NOW, locale)).toContain('\n\n' + subscribedCopy + '\n\n')
    expect(formatOverview(status(), [], undefined, NOW, locale)).toContain('\n\n' + unsubscribedCopy + '\n\n')
  })

  it.each(['', '/', '!'])('uses the three approved Chinese commands with prefix "%s" and clears retries on close', async prefix => {
    const { app, store, monitor, send, api, clock } = await setup()
    const client = app.mock.client('alice', 'group-a')
    const run = (command: string) => client.receive(prefix + command)
    const empty = await run('重置状态')
    expect(empty).toHaveLength(1)
    expect(empty[0]).toContain('当前会话未订阅。\n发送「重置订阅开启」接收重置预告和已执行重置提醒。')
    expect(await run('重置订阅开启')).toEqual(['订阅成功，当前会话将接收重置预告和已执行重置提醒。推送语言：简体中文。'])
    const before = (await store.subscriptions())[0]!
    expect(await run('重置订阅开启')).toEqual(['当前会话已订阅，无需重复订阅。推送语言：简体中文。'])
    expect((await store.subscriptions())[0]?.generation).toBe(before.generation)
    api.recent.mockResolvedValue({ data: [0, 1, 2].map(index => reset({ id: String(index) })), pagination: { has_more: false, next_cursor: null } })
    const active = await run('重置状态')
    expect(active[0]).toContain('当前会话已订阅：接收重置预告和已执行重置提醒。\n推送语言：简体中文。')
    expect(active[0]?.split('\n').filter(line => /^[123]\. /.test(line))).toHaveLength(3)
    expect(await store.subscriptions()).toEqual([before])
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(1)
    expect(await run('重置订阅关闭')).toEqual(['取消成功，已停止当前会话的重置推送。'])
    expect(await store.subscriptions()).toHaveLength(0)
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
    clock.advance(60_000)
    await monitor.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(await run('重置订阅关闭')).toEqual(['当前会话尚未订阅重置推送。'])
  })

  it.each(['', '/', '!'])('ignores retired Chinese commands and incomplete switches with prefix "%s"', async prefix => {
    const { app, store, wake } = await setup()
    const group = app.mock.client('alice', 'group-a'), direct = app.mock.client('alice')
    const retired = ['重置订阅', '重置取消', '重置訂閱', '重置订阅打开', '重置订阅开', '重置订阅关', '重置订阅 开启', '重置订阅 关闭']
    for (const client of [group, direct]) {
      for (const command of retired) expect(await client.receive(prefix + command)).toEqual([])
      await client.receive(prefix + '重置订阅开启')
      const before = await store.subscriptions()
      for (const command of retired) expect(await client.receive(prefix + command)).toEqual([])
      expect(await store.subscriptions()).toEqual(before)
      await client.receive(prefix + '重置订阅关闭')
    }
    expect(await store.subscriptions()).toHaveLength(0)
    expect(wake).toHaveBeenCalledTimes(2)
  })

  it.each([
    { open: '重置訂閱開啟', close: '重置订阅关闭', reply: '取消成功，已停止当前会话的重置推送。' },
    { open: '重置订阅开启', close: '重置訂閱關閉', reply: '取消成功，已停止目前會話的重置推送。' },
  ])('uses the explicit language of $close when closing a $open subscription', async ({ open, close, reply }) => {
    const { app, store } = await setup()
    const client = app.mock.client('alice')
    await client.receive(open)
    expect(await client.receive(close)).toEqual([reply])
    expect(await store.subscriptions()).toHaveLength(0)
    expect(await client.receive(close)).toEqual([close === '重置订阅关闭' ? '当前会话尚未订阅重置推送。' : '目前會話尚未訂閱重置推送。'])
  })

  it.each(locales)('applies signal priority through the actual status command without changing subscriptions in %s', async locale => {
    const { app, store, api, state, send, wake } = await setup()
    const client = app.mock.client('alice')
    await client.receive('リセット購読')
    const before = await store.subscriptions()
    const prediction = watch({ reset_chance_percent: 100, expires_at: new Date(Date.now() + 3600_000).toISOString() })
    state.current = status({ scheduled_reset: scheduled({ scheduled_for: null }), active_watch: prediction })
    api.recent.mockResolvedValue({ data: [reset()], pagination: { has_more: false, next_cursor: null } })
    const query = () => client.receive('/' + commandNames.status[locales.indexOf(locale)])
    const announcement = await query()
    expect(announcement).toHaveLength(1)
    expect(announcement[0]).toContain(text(locale, 'scheduled', { time: text(locale, 'noSchedule') }))
    expect(announcement[0]).not.toContain('100%')
    expect(announcement[0]).not.toContain(text(locale, 'noWatch'))
    state.current.data.scheduled_reset = null
    const forecast = await query()
    expect(forecast).toHaveLength(1)
    expect(forecast[0]).toContain(text(locale, 'activeWatch', { level: text(locale, 'elevated'), chance: '100%' }))
    expect(forecast[0]).not.toContain(text(locale, 'scheduledNotice'))
    state.current.data.active_watch!.expires_at = new Date(Date.now() - 1).toISOString()
    const expired = await query()
    expect(expired).toHaveLength(1)
    expect(expired[0]).toContain(text(locale, 'noWatch'))
    expect(expired[0]).not.toContain('100%')
    for (const reply of [announcement[0], forecast[0], expired[0]]) {
      expect(reply).toContain(text(locale, 'historyTitle'))
      expect(reply).toContain('1. ')
      expect(reply).toContain(text(locale, 'subscription', { language: '日本語' }))
    }
    expect(await store.subscriptions()).toEqual(before)
    expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
    expect(wake).toHaveBeenCalledTimes(1)
    expect(send).not.toHaveBeenCalled()
  })

  it.each(locales.flatMap((locale, index) => ['', '/', '!'].flatMap(prefix => [false, true].map(direct => ({ locale, index, prefix, direct })))))(
    'handles $locale with prefix "$prefix" in direct=$direct with single acknowledgements and no tests', async ({ locale, index, prefix, direct }) => {
      const { app, store, monitor, api, send, wake } = await setup()
      const client = app.mock.client('alice', direct ? undefined : 'group-a')
      const run = (action: keyof typeof commandNames) => client.receive(prefix + commandNames[action][index])
      expect(await run('subscribe')).toEqual([expect.stringContaining(subscribed[index]!)])
      expect((await store.subscriptions())[0]).toMatchObject({ locale, type: direct ? 'private' : 'channel' })
      expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
      expect(api.status).not.toHaveBeenCalled()
      expect(send).not.toHaveBeenCalled()
      expect(wake).toHaveBeenCalledTimes(1)
      const reply = await run('status')
      expect(reply).toHaveLength(1)
      expect(reply[0]).toContain(statusTitles[index])
      expect(reply[0]).toContain(timeZoneLabels[index]!.slice(1, -1))
      expect(reply[0]).toContain(text(locale, 'subscription', { language: languageNames[locale] }))
      expect(api.recent).toHaveBeenCalledTimes(1)
      expect(await store.checkpoint()).toBeNull()
      await monitor.poll()
      expect(send).toHaveBeenCalledTimes(1)
      expect(send.mock.calls[0]?.[1]).toContain(titles[index])
      expect(send.mock.calls[0]?.[1]).toContain(timeZoneLabels[index])
      expect(await run('unsubscribe')).toEqual([expect.stringContaining(cancelled[index]!)])
      expect(await store.subscriptions()).toHaveLength(0)
      expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
      expect(app.config.prefix).toBe('!')
    },
  )

  it('registers exactly three commands and removes standalone help, test, history, subscription and language entries', async () => {
    const { app, store, wake } = await setup()
    expect(app.$commander._commandList.filter(command => command.name.startsWith('codex')).map(command => command.name).sort()).toEqual(Object.values(commandIds).sort())
    const client = app.mock.client('alice', 'group-a')
    for (const input of ['/reset-test', '/reset-help', '/reset-subscription', '/reset-language en-US', '/重置推送测试', '/重置历史', '/重置语言 ja-JP', '/重置订阅开启状态', '/codex-reset.test', '/codex-reset.help', '/codex-reset.language ko-KR']) {
      expect(await client.receive(input)).toEqual([])
    }
    expect(await store.subscriptions()).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
  })

  it('allows public status and private management for authority-zero users but not group management by ordinary members', async () => {
    const { app, store, wake } = await setup('auto', 'member')
    const group = app.mock.client('alice', 'group-a')
    expect((await group.receive('重置状态'))[0]).toContain(statusTitles[1])
    for (const user of ['alice', 'operator']) {
      const client = app.mock.client(user, 'group-a')
      for (const input of ['重置订阅开启', '/重置订阅关闭', '/codexresetsubscribe', '/codex-reset.unsubscribe']) {
        expect(await client.receive(input)).toEqual([expect.stringContaining(input.includes('codex') ? 'Only the group owner' : '只有群主或群管理员')])
      }
    }
    expect(await store.subscriptions()).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
    const direct = app.mock.client('alice')
    expect(await direct.receive('重置订阅开启')).toEqual([expect.stringContaining('订阅成功')])
    expect(await direct.receive('重置订阅关闭')).toEqual([expect.stringContaining('取消成功')])
  })

  it('denies unavailable roles and prevents unauthorized cancellation and language changes', async () => {
    const { app, store } = await setup()
    const client = app.mock.client('alice', 'group-a')
    await client.receive('重置訂閱開啟')
    const before = (await store.subscriptions())[0]!
    client.event.member = { roles: [{ id: 'member' }] }
    await client.receive('reset-subscribe')
    await client.receive('重置订阅关闭')
    expect((await store.subscriptions())[0]).toMatchObject({ generation: before.generation, locale: 'zh-TW' })
    client.event.member = undefined
    app.bots[0]!.getGuildMember = vi.fn(async () => { throw new Error('offline') })
    expect((await client.receive('重置訂閱關閉'))[0]).toContain('無法核驗')
    expect(await store.subscriptions()).toHaveLength(1)
    expect((await client.receive('重置状态'))[0]).toContain(statusTitles[1])
  })

  it('keeps exact matching, other bot mentions and global Koishi permissions intact', async () => {
    const { app, store } = await setup()
    const client = app.mock.client('alice', 'group-a')
    for (const input of ['ordinary 重置订阅开启 text', '重置订阅开启其它', '//重置订阅开启', 'other', '/other', '<at id="another-bot"/> 重置订阅开启', '重置订阅开启 other-group']) {
      expect(await client.receive(input)).toEqual([])
    }
    await app.mock.initUser('operator-two', 1)
    expect(await app.mock.client('operator-two', 'group-a').receive('!other')).toEqual(['other-plugin'])
    app.$commander.get(commandIds.subscribe)!.config.permissions = ['authority:5']
    expect(await client.receive('/reset-subscribe')).toEqual(['Insufficient permissions.'])
    expect(await store.subscriptions()).toHaveLength(0)
  })

  it.each(['disabled', 'removed'].flatMap(mode => ['', '/', '!'].flatMap(prefix => [false, true].map(direct => ({ mode, prefix, direct })))))(
    'respects $mode aliases with prefix "$prefix" in direct=$direct', async ({ mode, prefix, direct }) => {
      const { app, store, api, wake } = await setup()
      const client = app.mock.client('alice', direct ? undefined : 'group-a')
      for (const action of ['status', 'subscribe', 'unsubscribe'] as const) {
        const command = app.$commander.get(commandIds[action])!
        const alias = commandNames[action][1]!
        if (mode === 'removed') delete command._aliases[alias]
        else command._aliases[alias]!.filter = false
      }
      expect(await client.receive(prefix + '重置状态')).toEqual([])
      expect(await client.receive(prefix + '重置订阅开启')).toEqual([])
      expect(await store.subscriptions()).toHaveLength(0)
      expect(api.status).not.toHaveBeenCalled()
      expect(api.recent).not.toHaveBeenCalled()
      expect(wake).not.toHaveBeenCalled()
      await client.receive('!reset-subscribe')
      const before = await store.subscriptions()
      expect(before).toHaveLength(1)
      expect(await client.receive(prefix + '重置订阅关闭')).toEqual([])
      expect(await store.subscriptions()).toEqual(before)
      expect(await client.receive('!reset-unsubscribe')).toEqual([expect.stringContaining(cancelled[0])])
      expect(await store.subscriptions()).toHaveLength(0)
    },
  )

  it.each(['', '/', '!'].flatMap(prefix => [false, true].map(direct => ({ prefix, direct }))))(
    'evaluates alias filters for each caller with prefix "$prefix" in direct=$direct', async ({ prefix, direct }) => {
      const { app, store } = await setup()
      for (const action of ['subscribe', 'unsubscribe'] as const) {
        app.$commander.get(commandIds[action])!._aliases[commandNames[action][1]!]!.filter = session => session.userId === 'operator'
      }
      const denied = app.mock.client('alice', direct ? undefined : 'group-a')
      const allowed = app.mock.client('operator', direct ? undefined : 'group-a')
      expect(await denied.receive(prefix + '重置订阅开启')).toEqual([])
      expect(await store.subscriptions()).toHaveLength(0)
      expect(await allowed.receive(prefix + '重置订阅开启')).toEqual([expect.stringContaining(subscribed[1])])
      const before = await store.subscriptions()
      expect(await denied.receive(prefix + '重置订阅关闭')).toEqual([])
      expect(await store.subscriptions()).toEqual(before)
      expect(await allowed.receive(prefix + '重置订阅关闭')).toEqual([expect.stringContaining(cancelled[1])])
      expect(await store.subscriptions()).toHaveLength(0)
    },
  )

  it.each(['', '/'])('respects filters on canonical and namespaced aliases with prefix "%s"', async prefix => {
    const { app, store, wake } = await setup()
    const command = app.$commander.get(commandIds.subscribe)!
    command._aliases[commandIds.subscribe]!.filter = false
    command._aliases['codex-reset.subscribe']!.filter = false
    const client = app.mock.client('alice', 'group-a')
    for (const alias of [commandIds.subscribe, 'codex-reset.subscribe', 'codex-reset subscribe']) {
      expect(await client.receive(prefix + alias)).toEqual([])
    }
    expect(await store.subscriptions()).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
    command._aliases['codex-reset.subscribe']!.filter = true
    expect(await client.receive(prefix + 'codex-reset subscribe')).toEqual([expect.stringContaining(subscribed[0])])
    expect((await store.subscriptions())[0]?.locale).toBe('en-US')
  })

  it.each(locales.flatMap((locale, index) => [false, true].map(direct => ({ locale, index, direct }))))(
    'keeps $locale for malformed native commands in direct=$direct without changing subscriptions', async ({ locale, index, direct }) => {
      const { app, store, api, wake } = await setup()
      await app.database.set('user', { onebot: 'alice' }, { locales: [locale === 'zh-CN' ? 'en-US' : 'zh-CN'] })
      const client = app.mock.client('alice', direct ? undefined : 'group-a')
      await client.receive('!重置订阅开启')
      const before = await store.subscriptions()
      wake.mockClear()
      for (const action of ['status', 'subscribe', 'unsubscribe'] as const) {
        for (const alias of [commandNames[action][index]!, '"' + commandNames[action][index] + '"']) {
          expect(await client.receive('!' + alias + ' extra')).toEqual([text(locale, 'extraArguments')])
          expect(await client.receive('!' + alias + ' --unknown')).toEqual([text(locale, 'unknownOptions')])
        }
      }
      expect(await store.subscriptions()).toEqual(before)
      expect(wake).not.toHaveBeenCalled()
      expect(api.status).not.toHaveBeenCalled()
      expect(api.recent).not.toHaveBeenCalled()
    },
  )

  it.each(locales)('uses fixed %s for both extra arguments and unknown options', async locale => {
    const { app, store, wake } = await setup(locale)
    const client = app.mock.client('alice')
    for (const action of ['status', 'subscribe', 'unsubscribe'] as const) {
      expect(await client.receive('!' + commandNames[action][1] + ' extra')).toEqual([text(locale, 'extraArguments')])
      for (const option of ['--unknown', '--unknown=value', '--no-unknown', '-x']) {
        expect(await client.receive('!' + commandNames[action][1] + ' ' + option)).toEqual([text(locale, 'unknownOptions')])
      }
      const name = commandIds[action]
      const session = app.mock.session({ ...client.event, type: 'interaction/command', argv: { name, arguments: [], options: {} } })
      expect((await session.execute({ name, args: [], options: { unknown: true } }, true)).join('')).toBe(text(locale, 'unknownOptions'))
    }
    expect(await store.subscriptions()).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
  })

  it.each(['', '/'].flatMap(prefix => [false, true].map(direct => ({ prefix, direct }))))(
    'keeps malformed fallback messages inert with prefix "$prefix" in direct=$direct', async ({ prefix, direct }) => {
      const { app, store, api, wake } = await setup()
      // Core may offer an interactive spelling suggestion in private chats. Isolate the plugin fallback.
      vi.spyOn(app.i18n, 'compare').mockReturnValue(0)
      const client = app.mock.client('alice', direct ? undefined : 'group-a')
      for (const aliases of Object.values(commandNames)) {
        for (const alias of aliases) {
          for (const suffix of [' extra', ' --unknown']) {
            expect(await client.receive(prefix + alias + suffix)).toEqual([])
          }
        }
      }
      expect(await store.subscriptions()).toHaveLength(0)
      expect(api.status).not.toHaveBeenCalled()
      expect(api.recent).not.toHaveBeenCalled()
      expect(wake).not.toHaveBeenCalled()
    },
  )

  it('preserves alias defaults and registered option permissions in the fallback', async () => {
    const { app, store, wake } = await setup()
    const command = app.$commander.get(commandIds.subscribe)!
    const alias = command._aliases['리셋구독']!
    const client = app.mock.client('alice')
    alias.args = ['extra']
    expect(await client.receive('/리셋구독')).toEqual([text('ko-KR', 'extraArguments')])
    alias.args = []
    alias.options = { unknown: true }
    expect(await client.receive('/리셋구독')).toEqual([text('ko-KR', 'unknownOptions')])
    command.config.showWarning = false
    expect(await client.receive('/리셋구독')).toEqual([])
    command.config.showWarning = true
    command.option('restricted', '-r', { authority: 5 })
    alias.options = { restricted: true }
    await client.receive('/리셋구독')
    expect(await store.subscriptions()).toHaveLength(0)
    expect(wake).not.toHaveBeenCalled()
    delete alias.options
    expect(await client.receive('/리셋구독')).toEqual([expect.stringContaining(subscribed[4])])
    expect((await store.subscriptions())[0]?.locale).toBe('ko-KR')
  })

  it.each([{ prefix: 're', index: 0 }, { prefix: '重置', index: 2 }, { prefix: 'リセット', index: 3 }, { prefix: '리셋', index: 4 }]
    .flatMap(value => [false, true].map(direct => ({ ...value, direct }))))(
    'preserves language with overlapping prefix "$prefix" in direct=$direct', async ({ prefix, index, direct }) => {
      const { app, store, monitor, send } = await setup('auto', 'admin', prefix)
      const client = app.mock.client('alice', direct ? undefined : 'group-a')
      let generation: string | undefined
      for (const form of ['', '/', prefix]) {
        expect(await client.receive(form + commandNames.subscribe[index])).toHaveLength(1)
        const subscription = (await store.subscriptions())[0]!
        expect(subscription.locale).toBe(locales[index])
        if (generation) expect(subscription.generation).toBe(generation)
        generation = subscription.generation
        expect((await client.receive(form + commandNames.status[index]))[0]).toContain(statusTitles[index])
      }
      await monitor.poll()
      expect(send.mock.calls[0]?.[1]).toContain(titles[index])
      await client.receive(commandNames.unsubscribe[index]!)
      expect(await store.subscriptions()).toHaveLength(0)
    },
  )

  it.each(locales.flatMap(locale => [false, true].map(direct => ({ locale, direct }))))(
    'enforces native alias filters for all three commands with locale=$locale and direct=$direct', async ({ locale, direct }) => {
      const { app, store, api, wake } = await setup(locale)
      const bot = app.bots[0]!
      bot.platform = 'discord'
      bot.internal = { getGuild: vi.fn(async () => ({ id: 'group-a', owner_id: '200' })) }
      await app.database.createUser('discord', '200', { authority: 0 })
      await app.database.createUser('discord', '201', { authority: 4 })
      const run = async (name: string, user = '200') => {
        const session = app.mock.session({ ...app.mock.client(user, direct ? undefined : 'group-a').event,
          platform: 'discord', type: 'interaction/command', argv: { name, arguments: [], options: {} } })
        return (await session.execute({ name, args: [], options: {} }, true)).join('')
      }
      for (const action of ['status', 'subscribe', 'unsubscribe'] as const) {
        const name = commandIds[action]
        app.$commander.get(name)!._aliases[name]!.filter = false
        expect(await run(name)).toBe(text(locale, 'lowAuthority'))
      }
      expect(api.status).not.toHaveBeenCalled()
      expect(api.recent).not.toHaveBeenCalled()
      expect(wake).not.toHaveBeenCalled()
      expect(await store.subscriptions()).toHaveLength(0)
      const subscribe = app.$commander.get(commandIds.subscribe)!
      // Disabling the canonical name must not disable a separate enabled alias.
      expect(await run('reset-subscribe')).toContain(subscribed[locales.indexOf(locale)])
      const before = await store.subscriptions()
      expect(await run(commandIds.unsubscribe)).toBe(text(locale, 'lowAuthority'))
      expect(await store.subscriptions()).toEqual(before)
      subscribe._aliases[subscribe.name]!.filter = session => session.userId === '200'
      expect(await run(subscribe.name, '201')).toBe(text(locale, 'lowAuthority'))
      subscribe.config.permissions = ['authority:4']
      expect(await run(subscribe.name)).toBe(text(locale, 'lowAuthority'))
      subscribe.config.permissions = ['authority:0']
      expect(await run(subscribe.name)).toContain(text(locale, 'already', { language: languageNames[locale] }))
      const unsubscribe = app.$commander.get(commandIds.unsubscribe)!
      unsubscribe.config.showWarning = false
      expect(await run(unsubscribe.name)).toBe('')
      expect(await store.subscriptions()).toEqual(before)
      unsubscribe.config.showWarning = true
      unsubscribe._aliases[unsubscribe.name]!.filter = session => session.userId === '200'
      expect(await run(unsubscribe.name)).toContain(cancelled[locales.indexOf(locale)])
      expect(await store.subscriptions()).toHaveLength(0)
    },
  )

  it.each((['auto', 'ja-JP'] as const).flatMap(locale => [false, true].map(direct => ({ locale, direct }))))(
    'handles structured interactions without message content with locale=$locale and direct=$direct', async ({ locale, direct }) => {
      const { app, store } = await setup(locale)
      const client = app.mock.client('alice', direct ? undefined : 'group-a')
      const run = async (action: keyof typeof commandNames) => {
        const name = commandIds[action]
        const session = app.mock.session({ ...client.event, type: 'interaction/command', argv: { name, arguments: [], options: {} } })
        expect(session.content).toBeUndefined()
        return (await session.execute({ name, args: [], options: {} }, true)).join('')
      }
      expect(await run('status')).toContain(statusTitles[locale === 'auto' ? 0 : 3])
      expect(await store.subscriptions()).toHaveLength(0)
      expect(await run('subscribe')).toContain(subscribed[locale === 'auto' ? 0 : 3])
      expect((await store.subscriptions())[0]?.locale).toBe('en-US')
      expect(await run('unsubscribe')).toContain(cancelled[locale === 'auto' ? 0 : 3])
      expect(await store.subscriptions()).toHaveLength(0)
    },
  )

  it.each(['telegram', 'discord'])('applies platform authorization to native %s command execution', async platform => {
    const { app, store } = await setup()
    const bot = app.bots[0]!
    let permitted = false
    bot.internal = platform === 'telegram'
      ? { getChatMember: vi.fn(async () => ({ user: { id: 200 }, status: permitted ? 'administrator' : 'member' })) }
      : { getGuild: vi.fn(async () => ({ id: 'group-a', owner_id: permitted ? '200' : 'owner' })),
        getGuildMember: vi.fn(async () => ({ user: { id: '200' }, roles: [] })),
        getGuildRoles: vi.fn(async () => [{ id: 'group-a', permissions: '0' }]) }
    const run = async (name: string) => {
      const session = app.mock.session({ ...app.mock.client('200', 'group-a').event, platform, user: { id: '200' } })
      return (await session.execute({ name, args: [] }, true)).join('')
    }
    await run(commandIds.status)
    await run(commandIds.subscribe)
    expect(await store.subscriptions()).toHaveLength(0)
    permitted = true
    expect(await run(commandIds.subscribe)).toContain('Subscription successful.')
    expect((await store.subscriptions())[0]?.platform).toBe(platform)
    permitted = false
    await run(commandIds.unsubscribe)
    expect(await store.subscriptions()).toHaveLength(1)
    permitted = true
    expect(await run(commandIds.unsubscribe)).toContain('Cancellation successful.')
    expect(await store.subscriptions()).toHaveLength(0)
  })

  it('uses the command name without event argv and preserves subscriptions when one query endpoint fails', async () => {
    const { app, store, api } = await setup()
    const session = app.mock.session(app.mock.client('alice').event)
    await session.execute({ name: commandIds.subscribe, args: [] }, true)
    expect((await store.subscriptions())[0]?.locale).toBe('en-US')
    api.recent.mockRejectedValueOnce(new Error('history unavailable'))
    const first = await app.mock.client('alice').receive('reset-status')
    expect(first).toHaveLength(1)
    expect(first[0]).toContain(statusTitles[0])
    expect(first[0]).toContain('history is temporarily unavailable')
    expect(first[0]).toContain('English')
    api.status.mockRejectedValueOnce(new Error('status unavailable'))
    api.recent.mockResolvedValueOnce({ data: [reset({ text: 'history-still-available' })], pagination: { has_more: false, next_cursor: null } })
    const partial = (await app.mock.client('alice').receive('reset-status'))[0]!
    expect(partial).toContain('1. 10/25/2026, 03:00')
    expect(partial).not.toContain('history-still-available')
    expect(await store.subscriptions()).toHaveLength(1)
  })

  it('updates language without replaying events, and re-renders pending notices after restart', async () => {
    const { app, store, monitor, api, clock, send } = await setup()
    const group = app.mock.client('alice', 'group-a')
    await group.receive('重置订阅开启')
    const before = (await store.subscriptions())[0]!
    send.mockRejectedValueOnce(new Error('offline'))
    await monitor.poll()
    await group.receive('리셋구독')
    expect((await store.subscriptions())[0]).toMatchObject({ generation: before.generation, subscribedAt: before.subscribedAt, locale: 'ko-KR' })
    clock.advance(60_000)
    send.mockReset().mockResolvedValue(undefined)
    const restarted = new Monitor(new KoishiStore(app), api, send, { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toContain(titles[4])
    expect(send.mock.calls[0]?.[1]).toContain('14:00 (UTC+09:00)')
    await group.receive('reset-subscribe')
    await restarted.poll()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(locales)('retains forced %s configuration, translated fields and three-command usage', async locale => {
    const { app, monitor, send, store } = await setup(locale)
    const client = app.mock.client('alice')
    expect((await client.receive('重置订阅开启'))[0]).toContain(subscribed[locales.indexOf(locale)])
    expect((await store.subscriptions())[0]?.locale).toBe('zh-CN')
    await monitor.poll()
    expect(send.mock.calls[0]?.[1]).toContain(titles[locales.indexOf(locale)])
    expect(send.mock.calls[0]?.[1]).toContain(timeZoneLabels[locales.indexOf(locale)])
    const reply = (await client.receive('重置状态'))[0]
    expect(reply).toContain(timeZoneLabels[locales.indexOf(locale)]!.slice(1, -1))
    expect(plugin.Config.dict!.commandAuthority).toBeUndefined()
    expect(plugin.Config.dict!.timeZone).toBeUndefined()
    expect(plugin.defaults).not.toHaveProperty('timeZone')
    expect(plugin.usage[locale]).toContain('UTC+8')
    expect(plugin.usage[locale]).toContain('UTC+9')
    expect(plugin.usage[locale]).toContain(commandNames.subscribe[locales.indexOf(locale)])
    expect(plugin.usage[locale]).not.toContain('reset-test')
    for (const field of Object.values(plugin.Config.dict!)) expect((field.meta.description as Record<string, string>)[locale]).toBeTruthy()
  })

  it('uses the query language for time display without changing the saved notification language', async () => {
    const { app, store, monitor, send, api } = await setup()
    api.recent.mockResolvedValue({ data: [reset()], pagination: { has_more: false, next_cursor: null } })
    const client = app.mock.client('alice')
    await client.receive('リセット購読')
    for (const [command, time, zone] of [['reset-status', '03:00', 'UTC'], ['重置状态', '11:00', 'UTC+08:00'], ['リセット状況', '12:00', 'UTC+09:00']]) {
      const reply = (await client.receive(command!))[0]!
      expect(reply).toContain(time!)
      expect(reply).toContain(zone!)
    }
    expect((await store.subscriptions())[0]?.locale).toBe('ja-JP')
    await monitor.poll()
    expect(send.mock.calls[0]?.[1]).toContain('14:00 (UTC+09:00)')
  })

  it.each(locales)('renders only three distinct recent resets with safe source text in %s', locale => {
    const records = [0, 3, 2, 1, 3].map(index => reset({ id: String(index), text: 'history-' + index + ' <at type="all"/>', announced_at: new Date(NOW + index * 60_000).toISOString() }))
    const overview = formatOverview(status(), records, locale, NOW, locale)
    expect(overview).not.toContain('history-')
    expect(overview).not.toContain('<at')
    const entries = overview.split('\n').filter(line => /^\d\. /.test(line))
    expect(entries).toHaveLength(3)
    expect(entries[0]).toContain(':03')
    expect(entries[1]).toContain(':02')
    expect(entries[2]).toContain(':01')
    expect(overview).toContain(languageNames[locale])
    expect(formatReset(reset(), locale)).toContain(resetTitles[locales.indexOf(locale)])
    expect(formatScheduled(scheduled({ scheduled_for: null }), locale)).toContain(titles[locales.indexOf(locale)])
    expect(overview).not.toMatch(/undefined|\{\w+\}/)
  })
})
