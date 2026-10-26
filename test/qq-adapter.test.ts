import { createRequire } from 'node:module'
import type { App as KoishiApp } from 'koishi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NOW, reset, scheduled, status } from './helpers'

const require = createRequire(import.meta.url)
const { App, Bot, Universal, Logger } = require('koishi') as typeof import('koishi')
const { QQBot, adaptSession } = require('@satorijs/adapter-qq') as typeof import('@satorijs/adapter-qq')
const Memory = require('@minatojs/driver-memory').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { managementAccess } = require('../lib/permissions') as typeof import('../src/permissions')
const { KoishiStore } = require('../lib/store') as typeof import('../src/store')
const { locales, text } = require('../lib/locales') as typeof import('../src/locales')
const apps: KoishiApp[] = []
const defaultLogTargets = Logger.targets

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop()
  Logger.targets = defaultLogTargets
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// Real published encoder, session decoder and member conversion, with all network calls stubbed.
class QQFixture extends Bot {
  static MessageEncoder = QQBot.MessageEncoder
  wire: { route: 'private' | 'group'; id: string; data: { content: string; msg_type: number; msg_id?: string } }[] = []
  http = { isError: () => false }

  constructor(app: KoishiApp) {
    super(app, { id: 'APPLICATION_ID', retryWhen: [], intents: 0 }, 'qq')
    this.user = { id: 'LOGIN_BOT_ID' }
    const send = (route: 'private' | 'group') => vi.fn(async (id, data) => {
      this.wire.push({ route, id, data: JSON.parse(JSON.stringify(data)) })
      return { id: `fixture-${this.wire.length}`, timestamp: new Date(NOW).toISOString() }
    })
    this.internal = {
      sendPrivateMessage: send('private'), sendMessage: send('group'),
      getGuildMember: vi.fn(async (_group, id) => ({ member_openid: id, member_role: 'admin',
        username: 'fixture', joined_at: new Date(NOW).toISOString() })),
    }
    this.online()
  }

  createDirectChannel(id: string) { return QQBot.prototype.createDirectChannel.call(this as never, id) }
  getGuildMember(group: string, id: string) { return QQBot.prototype.getGuildMember.call(this as never, group, id) }
}

async function setup(locale: typeof locales[number] = 'en-US', sendIntervalMs = 1000) {
  vi.useFakeTimers({ now: NOW })
  const app = new App()
  apps.push(app)
  app.plugin(Memory)
  app.plugin(QQFixture)
  const bot = app.bots[0]! as QQFixture
  app.http = vi.fn(async () => ({ status: 200, headers: new Headers(), data: JSON.stringify(status({ scheduled_reset: scheduled() })) })) as unknown as typeof app.http
  app.plugin(plugin, { pollIntervalMs: 60_000, locale, sendIntervalMs })
  await app.start()
  await vi.advanceTimersByTimeAsync(0)
  vi.spyOn(require('../lib/util').clock, 'sleep').mockResolvedValue(undefined)
  return { app, bot, store: new KoishiStore(app) }
}

async function incoming(bot: QQFixture, direct: boolean, role?: string) {
  return (await adaptSession(bot as never, {
    t: direct ? 'C2C_MESSAGE_CREATE' : 'GROUP_AT_MESSAGE_CREATE',
    d: { id: 'incoming-message', timestamp: new Date(NOW).toISOString(), content: '重置订阅开启',
      group_id: direct ? undefined : 'GROUP_OPENID', author: { id: 'MEMBER_OPENID', member_role: role } },
  } as never))!
}

describe('published QQ adapter integration', () => {
  it.each(['owner', 'admin', 'member'])('recognizes native decoded event role %s without manual grants', async role => {
    const { bot } = await setup()
    const session = await incoming(bot, false, role)
    expect(session.event.member?.roles).toEqual([{ id: role }])
    expect(await managementAccess(session)).toBe(role === 'member' ? 'denied' : 'allowed')
    expect(bot.internal.getGuildMember).not.toHaveBeenCalled()
  })

  it('queries actual QQ member conversion and refuses a later demotion even with a manual grant', async () => {
    const { bot, store } = await setup()
    const session = await incoming(bot, false)
    expect((await session.execute({ name: 'codexresetsubscribe', args: [] }, true)).join('')).toContain('Subscription successful')
    expect(bot.internal.getGuildMember).toHaveBeenCalledWith('GROUP_OPENID', 'MEMBER_OPENID')
    expect(await store.subscriptions()).toHaveLength(1)
    bot.internal.getGuildMember.mockResolvedValue({ member_openid: 'MEMBER_OPENID', member_role: 'member' })
    const grants = [{ selfId: bot.selfId, groupId: 'GROUP_OPENID', userIds: ['MEMBER_OPENID'] }]
    expect(await managementAccess(session, grants)).toBe('denied')
    expect((await session.execute({ name: 'codexresetunsubscribe', args: [] }, true)).join('')).toBe(text('en-US', 'adminOnly'))
    expect(await store.subscriptions()).toHaveLength(1)
  })

  it('uses the login selfId rather than the configured application ID for fallback grants', async () => {
    const { bot } = await setup()
    const session = await incoming(bot, false)
    bot.internal.getGuildMember.mockRejectedValue(new Error('no member API permission'))
    const grant = { selfId: bot.config.id, groupId: 'GROUP_OPENID', userIds: ['MEMBER_OPENID'] }
    expect(session.selfId).toBe('LOGIN_BOT_ID')
    expect(await managementAccess(session, [grant])).toBe('qqNotConfigured')
    grant.selfId = session.selfId
    expect(await managementAccess(session, [grant])).toBe('allowed')
  })

  it.each([true, false])('keeps both notification types on their original QQ route after a failed send (private=%s)', async direct => {
    const records: string[] = []
    Logger.targets = [{ record: record => { if (record.name === 'codex-resets' && record.type === 'warn') records.push(record.content) } }]
    const { bot, store } = await setup()
    const session = await incoming(bot, direct, 'admin')
    await session.execute({ name: 'codexresetsubscribe', args: [] }, true)
    const sub = (await store.subscriptions())[0]!
    await store.enqueue({ id: 'retry-executed', subscriptionId: sub.id, generation: sub.generation,
      eventKey: 'reset:regular:retry-executed', kind: 'reset', content: '',
      payload: { type: 'reset', reset: reset() }, createdAt: NOW,
      expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0 })
    const endpoint = direct ? bot.internal.sendPrivateMessage : bot.internal.sendMessage
    const original = endpoint.getMockImplementation()
    const failure = Object.assign(new Error('Request failed'), {
      response: { status: 403, data: { code: 40034105, message: 'push denied; token=fixture-secret' } },
    })
    // Exercise the real encoder's empty-message AggregateError, not just a direct throw.
    vi.spyOn(bot.http, 'isError').mockReturnValue(true)
    endpoint.mockRejectedValue(failure)
    await vi.advanceTimersByTimeAsync(1000)
    expect(bot.wire).toHaveLength(0)
    expect(await store.pending(NOW + 60_000)).toHaveLength(2)
    expect(endpoint).toHaveBeenCalledTimes(2) // Permission failures must not trigger URL fallback.
    expect((await store.pending(NOW + 60_000)).every(row => row.attempts === 1 && row.sentAt === 0)).toBe(true)
    expect(records).toHaveLength(2)
    for (const message of records) {
      expect(message).toContain('推送失败，将重试')
      expect(message).toContain('HTTP 403')
      expect(message).toContain('code=40034105')
      expect(message).toContain('push denied')
      expect(message).not.toContain('fixture-secret')
    }
    endpoint.mockImplementation(original)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(bot.wire).toHaveLength(2)
    expect(bot.wire.every(row => row.route === (direct ? 'private' : 'group') && row.id === sub.targetId)).toBe(true)
    expect(bot.wire.some(row => row.data.content.includes(text('en-US', 'scheduledTitle')))).toBe(true)
    expect(bot.wire.some(row => row.data.content.includes(text('en-US', 'resetTitle')))).toBe(true)
    expect(await store.pending(NOW + 120_000)).toHaveLength(0)
  })

  it.each([true, false])('retries both proactive notification types without the source URL only on QQ code 40054010 (private=%s)', async direct => {
    const records: string[] = []
    Logger.targets = [{ record: record => { if (record.name === 'codex-resets') records.push(record.content) } }]
    const { bot, store } = await setup()
    await (await incoming(bot, direct, 'admin')).execute({ name: 'codexresetsubscribe', args: [] }, true)
    const sub = (await store.subscriptions())[0]!
    await store.enqueue({ id: 'url-executed', subscriptionId: sub.id, generation: sub.generation,
      eventKey: 'reset:regular:url-executed', kind: 'reset', content: '', payload: { type: 'reset', reset: reset() },
      createdAt: NOW, expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0 })
    const endpoint = direct ? bot.internal.sendPrivateMessage : bot.internal.sendMessage
    const original = endpoint.getMockImplementation()!
    vi.spyOn(bot.http, 'isError').mockReturnValue(true)
    endpoint.mockImplementation(async (id, data) => {
      if (data.content.includes('https://codex-resets.com')) throw Object.assign(new Error(), {
        response: { status: 400, data: { code: 40054010, message: 'URL not allowed' } },
      })
      return original(id, data)
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(endpoint).toHaveBeenCalledTimes(4)
    expect(bot.wire).toHaveLength(2)
    for (const row of bot.wire) {
      expect(row.route).toBe(direct ? 'private' : 'group')
      expect(row.id).toBe(sub.targetId)
      expect(row.data).toEqual({ msg_type: 0, content: expect.any(String) })
      expect(row.data.content).toContain('Codex Resets')
      expect(row.data.content).not.toContain('https://')
    }
    expect(records.filter(message => message.includes('HTTP 400；code=40054010；URL not allowed'))).toHaveLength(2)
    expect(await store.pending(NOW + 60_000)).toHaveLength(0)
  })

  it('stops after one failed URL fallback and leaves the notification queued for the normal retry', async () => {
    const { bot, store } = await setup()
    await (await incoming(bot, false, 'admin')).execute({ name: 'codexresetsubscribe', args: [] }, true)
    vi.spyOn(bot.http, 'isError').mockReturnValue(true)
    bot.internal.sendMessage.mockRejectedValue(Object.assign(new Error(), {
      response: { status: 400, data: { code: 40054010, message: 'URL not allowed' } },
    }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(bot.internal.sendMessage).toHaveBeenCalledTimes(2)
    expect(bot.wire).toHaveLength(0)
    expect(await store.pending(NOW + 60_000)).toEqual([expect.objectContaining({ attempts: 1, sentAt: 0 })])
  })

  it.each([1000, 5000])('paces QQ submissions including URL fallback with configured interval %s', async interval => {
    const { bot, store } = await setup('en-US', interval)
    await (await incoming(bot, false, 'admin')).execute({ name: 'codexresetsubscribe', args: [] }, true)
    const sub = (await store.subscriptions())[0]!
    await store.enqueue({ id: 'paced-executed', subscriptionId: sub.id, generation: sub.generation,
      eventKey: 'reset:regular:paced-executed', kind: 'reset', content: '', payload: { type: 'reset', reset: reset() },
      createdAt: NOW, expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0 })
    vi.mocked(require('../lib/util').clock.sleep).mockImplementation(ms => new Promise(resolve => setTimeout(resolve, ms)))
    const times: number[] = []
    const original = bot.internal.sendMessage.getMockImplementation()!
    vi.spyOn(bot.http, 'isError').mockReturnValue(true)
    bot.internal.sendMessage.mockImplementation(async (id, data) => {
      times.push(Date.now())
      if (data.content.includes('https://')) throw Object.assign(new Error(), {
        response: { status: 400, data: { code: 40054010, message: 'URL not allowed' } },
      })
      return original(id, data)
    })
    const gap = Math.max(interval, 3100)
    await vi.advanceTimersByTimeAsync(1000)
    expect(times).toEqual([NOW + 1000])
    await vi.advanceTimersByTimeAsync(gap * 3)
    expect(times).toEqual([0, 1, 2, 3].map(index => NOW + 1000 + gap * index))
    expect(bot.wire).toHaveLength(2)
  })

  it.each([true, false])('does not submit a delayed URL fallback after cancellation (private=%s)', async direct => {
    const { bot, store } = await setup()
    const session = await incoming(bot, direct, 'admin')
    await session.execute({ name: 'codexresetsubscribe', args: [] }, true)
    vi.mocked(require('../lib/util').clock.sleep).mockImplementation(ms => new Promise(resolve => setTimeout(resolve, ms)))
    const endpoint = direct ? bot.internal.sendPrivateMessage : bot.internal.sendMessage
    vi.spyOn(bot.http, 'isError').mockReturnValue(true)
    endpoint.mockRejectedValueOnce(Object.assign(new Error(), {
      response: { status: 400, data: { code: 40054010, message: 'URL not allowed' } },
    }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(endpoint).toHaveBeenCalledTimes(1)
    await session.execute({ name: 'codexresetunsubscribe', args: [] }, true)
    await vi.advanceTimersByTimeAsync(3100)
    expect(endpoint).toHaveBeenCalledTimes(1)
    expect(await store.subscriptions()).toHaveLength(0)
    expect(bot.wire).toHaveLength(0)
  })

  it.each(locales.flatMap(locale => [true, false].map(direct => ({ locale, direct }))))(
    'delivers announcements and executed resets through the correct endpoint, then cancels ($locale, private=$direct)', async ({ locale, direct }) => {
      const { app, bot, store } = await setup(locale)
      const session = await incoming(bot, direct, 'admin')
      const subscriptionReply = await session.execute({ name: 'codexresetsubscribe', args: [] }, true)
      expect(subscriptionReply).toHaveLength(1)
      expect(bot.wire).toHaveLength(0)
      const sub = (await store.subscriptions())[0]!
      expect(sub.locale).toBe('zh-CN') // Command language is saved; fixed locale controls output.
      expect(sub.selfId).toBe('LOGIN_BOT_ID')
      expect(sub.targetId).toBe(direct ? 'MEMBER_OPENID' : 'GROUP_OPENID')
      await store.enqueue({ id: 'executed', subscriptionId: sub.id, generation: sub.generation,
        eventKey: 'reset:regular:executed', kind: 'reset', content: '',
        payload: { type: 'reset', reset: reset() }, createdAt: NOW,
        expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0 })
      await vi.advanceTimersByTimeAsync(1000)
      expect(bot.wire).toHaveLength(2)
      expect(bot.wire.every(row => row.route === (direct ? 'private' : 'group') && row.id === sub.targetId)).toBe(true)
      expect(bot.wire.some(row => row.data.content.includes(text(locale, 'scheduledTitle')))).toBe(true)
      expect(bot.wire.some(row => row.data.content.includes(text(locale, 'resetTitle')))).toBe(true)
      for (const row of bot.wire) {
        // Active TEXT requests: no stale msg_id/event_id/msg_seq or is_wakeup.
        expect(row.data).toEqual({ content: expect.any(String), msg_type: 0 })
        expect(row.data.content).toContain('https://codex-resets.com')
      }
      expect((await app.database.get('codex_reset_delivery', {})).every(row => row.sentAt > 0)).toBe(true)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(bot.wire).toHaveLength(2)
      const cancel = await session.execute({ name: 'codexresetunsubscribe', args: [] }, true)
      expect(cancel).toHaveLength(1)
      expect(cancel.join('')).toBe(text(locale, 'unsubscribed'))
      expect(await store.subscriptions()).toHaveLength(0)
      expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
    },
  )
})
