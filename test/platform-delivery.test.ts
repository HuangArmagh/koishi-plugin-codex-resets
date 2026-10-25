import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot, h as Element } from 'koishi'
import { NOW, reset, status, watch, scheduled } from './helpers'

const require = createRequire(import.meta.url)
const { App, h, Universal } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const Mock = require('@koishijs/plugin-mock').default
const Sandbox = require('@koishijs/plugin-sandbox')
const { TelegramMessageEncoder } = require('@satorijs/adapter-telegram') as typeof import('@satorijs/adapter-telegram')
const plugin = require('../lib/index') as typeof import('../src/index')
const { KoishiStore } = require('../lib/store') as typeof import('../src/store')
const { locales, text } = require('../lib/locales') as typeof import('../src/locales')
const { formatReset, formatScheduled, formatOverview, formatTime } = require('../lib/format') as typeof import('../src/format')
const { messageContent } = require('../lib/messages') as typeof import('../src/messages')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function session(bot: Bot, direct = true) {
  return bot.session({ type: 'interaction/command', platform: bot.platform, user: { id: '200' },
    guild: direct ? undefined : { id: '-100123' },
    channel: { id: direct ? '@200' : '42', type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT } })
}

async function enqueueReset(store: InstanceType<typeof KoishiStore>, bot: Bot, direct = true, content?: string) {
  const destination = plugin.targetFromSession(session(bot, direct))!
  let subscription = await store.subscription(destination.id)
  // Pre-existing group subscriptions exercise routing without granting sandbox group permissions.
  if (!subscription) {
    subscription = { ...destination, generation: 'test-generation', subscribedAt: NOW, locale: 'en-US', baselined: false, baselineResetKey: '' }
    await store.saveSubscription(subscription)
  }
  await store.enqueue({ id: content ? 'legacy' : 'executed', subscriptionId: subscription.id, generation: subscription.generation,
    eventKey: content ? 'reset:regular:legacy' : 'reset:regular:executed', kind: 'reset', content: content ?? '',
    payload: content ? null : { type: 'reset', reset: reset({ text: '😀<&'.repeat(1800), source: { type: 'observed', url: 'https://example.invalid/' + 'a'.repeat(6000) } }) },
    createdAt: NOW, expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0 })
}

async function sandbox() {
  vi.useFakeTimers({ now: NOW })
  const app = new App()
  app.plugin(Memory)
  const listeners: Record<string, Function> = {}
  app.set('console', { clients: {}, services: {}, addEntry() {}, broadcast() {},
    addListener(name: string, callback: Function) { listeners[name] = callback } })
  app.set('server', {})
  const messages: { type: string; body: { content?: string; channel?: string } }[] = []
  const client = { id: 'local-test-console', send: (message: typeof messages[number]) => messages.push(message) }
  app.http = vi.fn(async () => ({ status: 200, headers: new Headers(), data: JSON.stringify(status({ scheduled_reset: scheduled() })) })) as unknown as typeof app.http
  app.plugin(Sandbox, { fileServer: { enabled: false } })
  app.plugin(plugin, { pollIntervalMs: 60_000 })
  cleanups.push(() => app.stop())
  await app.start()
  await listeners['sandbox/set-user']!.call(client, 'sandbox:regression', '200', { authority: 0 })
  await vi.advanceTimersByTimeAsync(0)
  const bot = app.bots[0]!
  expect(bot.adapterName).toBe('sandbox')
  expect(bot.hidden).toBe(true)
  expect(bot.status).toBe(Universal.Status.CONNECT)
  vi.spyOn(require('../lib/util').clock, 'sleep').mockResolvedValue(undefined)
  return { app, bot, messages, store: new KoishiStore(app) }
}

describe('official sandbox proactive delivery', () => {
  it.each([true, false])('sends announcements and executed resets while CONNECT (private=%s)', async direct => {
    const { app, bot, messages, store } = await sandbox()
    if (direct) {
      const reply = await session(bot).execute({ name: 'codexresetsubscribe', args: [] }, true)
      expect(reply).toHaveLength(1)
      expect(reply.join('')).toContain('Subscription successful')
      expect(messages).toHaveLength(0)
    }
    await enqueueReset(store, bot, direct)
    await vi.advanceTimersByTimeAsync(direct ? 1000 : 60_000)
    const pushed = messages.filter(message => message.type === 'sandbox/message')
    expect(pushed).toHaveLength(2)
    expect(pushed.every(message => message.body.channel === (direct ? '@200' : '42'))).toBe(true)
    expect(pushed.some(message => message.body.content?.includes('[Codex reset announced]'))).toBe(true)
    expect(pushed.some(message => message.body.content?.includes('[Codex reset executed]'))).toBe(true)
    expect((await app.database.get('codex_reset_delivery', {})).every(row => row.sentAt > 0)).toBe(true)
    expect(bot.status).toBe(Universal.Status.CONNECT)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(messages).toHaveLength(2)
    if (direct) {
      const reply = await session(bot).execute({ name: 'codexresetunsubscribe', args: [] }, true)
      expect(reply.join('')).toContain('Cancellation successful')
      expect(await store.subscriptions()).toHaveLength(0)
      expect(await app.database.get('codex_reset_delivery', {})).toHaveLength(0)
    }
  })

  it.each([
    { platform: 'sandbox:regression', adapterName: 'sandbox', hidden: true, status: Universal.Status.OFFLINE },
    { platform: 'sandbox:regression', adapterName: 'sandbox', hidden: true, status: Universal.Status.DISCONNECT },
    { platform: 'sandbox:regression', adapterName: 'onebot', hidden: true, status: Universal.Status.CONNECT },
    { platform: 'sandbox:regression', adapterName: 'sandbox', hidden: false, status: Universal.Status.CONNECT },
    ...['onebot', 'telegram', 'discord', 'sandbox', 'sandbox-fake'].map(platform => ({ platform, adapterName: 'sandbox', hidden: true, status: Universal.Status.CONNECT })),
  ])('still blocks unavailable or non-sandbox bots: $platform/$adapterName/$hidden/$status', async attributes => {
    const { bot, messages, store } = await sandbox()
    Object.assign(bot, attributes)
    await session(bot).execute({ name: 'codexresetsubscribe', args: [] }, true)
    await enqueueReset(store, bot)
    await vi.advanceTimersByTimeAsync(1000)
    expect(messages).toHaveLength(0)
    const queued = await store.pending(NOW + 60_000)
    expect(queued).toHaveLength(2)
    expect(queued.every(row => row.sentAt === 0 && row.attempts > 0)).toBe(true)
  })

  it('does not treat sandbox authority 4 as platform group administrator', async () => {
    const { app, bot, store } = await sandbox()
    const group = session(bot, false)
    await app.database.setUser(bot.platform!, '200', { authority: 4 })
    for (const name of ['codexresetsubscribe', 'codexresetunsubscribe']) {
      expect((await group.execute({ name, args: [] }, true)).join('')).toContain('Could not verify your group administrator permissions')
    }
    expect(await store.subscriptions()).toHaveLength(0)
    expect(app.http).not.toHaveBeenCalled()
  })
})

async function telegram() {
  const app = new App()
  app.plugin(Memory)
  const mock = app.plugin(Mock)
  const oversizedWatch = watch({ forecast_window: '😀<&'.repeat(1800), text: 'forecast body '.repeat(400), source: { type: 'x_post', url: 'https://example.invalid/' + 'a'.repeat(6000) } })
  const oversizedScheduled = scheduled({ text: oversizedWatch.text, source: oversizedWatch.source })
  app.http = vi.fn(async () => ({ status: 200, headers: new Headers(), data: JSON.stringify(status({ active_watch: oversizedWatch, scheduled_reset: oversizedScheduled })) })) as unknown as typeof app.http
  app.plugin(plugin, { pollIntervalMs: 60_000 })
  await app.start()
  const bot = app.bots[0]!
  bot.platform = 'telegram'
  cleanups.push(async () => { bot.platform = 'mock'; await mock.dispose(); await app.stop() })
  const wire: { chat_id: string; message_thread_id?: number; text: string; parse_mode: string }[] = []
  const sendMessage = vi.fn(async (payload: typeof wire[number]) => {
    const plain = h.unescape(payload.text)
    if (plain.length > 4096 || !plain.isWellFormed()) throw new Error('Telegram rejected invalid text')
    wire.push(payload)
    return { message_id: wire.length, date: NOW / 1000, chat: { id: Number(payload.chat_id), type: 'private' }, text: plain }
  })
  bot.internal = { sendMessage, getChatMember: async () => ({ user: { id: 200 }, status: 'administrator' }) }
  const encode = async (value: Element.Fragment, direct = true) => (await new TelegramMessageEncoder(bot as never, direct ? '200' : '42', undefined,
    direct ? undefined : { session: session(bot, false) }).send(value)).map(row => row.id!)
  vi.spyOn(bot, 'sendPrivateMessage').mockImplementation((_user, content) => encode(content))
  vi.spyOn(bot, 'sendMessage').mockImplementation((_channel, content) => encode(content, false))
  return { app, bot, wire, sendMessage, encode, oversizedWatch, oversizedScheduled }
}

describe('official Telegram encoder length limits', () => {
  it.each(locales)('preserves essential fields and attribution with oversized data in %s', async locale => {
    const { encode, wire, oversizedWatch, oversizedScheduled } = await telegram()
    const record = reset({ text: '😀<&'.repeat(1800), source: oversizedWatch.source })
    const values = [formatScheduled(oversizedScheduled, locale, 'telegram'), formatReset(record, locale, 'telegram'),
      formatOverview(status({ active_watch: oversizedWatch }), [record], locale, NOW, locale, 'telegram')]
    for (const value of values) {
      await encode(h.text(messageContent(value, 'telegram')))
      const payload = wire.at(-1)!
      expect(payload.parse_mode).toBe('html')
      expect(payload.text).not.toMatch(/<at\b|<img\b/)
      const plain = h.unescape(payload.text)
      expect(plain.length).toBeLessThanOrEqual(4096)
      expect(plain).toBe(value) // Essential fields survive without whole-message truncation.
      expect(plain).toContain(text(locale, 'attribution'))
      expect(plain).not.toContain('https://example.invalid/')
    }
    expect(wire).toHaveLength(3)
    expect(h.unescape(wire[0]!.text)).toContain(text(locale, 'scheduledAt', { time: formatTime(oversizedScheduled.scheduled_for!, locale) }))
    expect(h.unescape(wire[0]!.text)).toContain(text(locale, 'scheduledPushNotice'))
    expect(h.unescape(wire[1]!.text)).toContain(text(locale, 'recordedAt', { time: formatTime(record.announced_at, locale) }))
  })

  it.each(['a'.repeat(4096), 'a'.repeat(4097), '😀'.repeat(2048), 'a'.repeat(4094) + '😀x', '<&'.repeat(3000)])('bounds legacy text without splitting emoji or HTML entities (%#)', async value => {
    const { encode, wire } = await telegram()
    await encode(h.text(messageContent(value, 'telegram')))
    expect(wire).toHaveLength(1)
    const plain = h.unescape(wire[0]!.text)
    expect(plain.isWellFormed()).toBe(true)
    expect(plain.length).toBeLessThanOrEqual(4096)
    expect(messageContent(plain, 'telegram')).toBe(plain)
    if (value.length <= 4096) expect(plain).toBe(value)
    else expect(plain.endsWith('…')).toBe(true)
  })

  it('omits upstream body and source URL through the official Telegram encoder', async () => {
    const { encode, wire } = await telegram()
    const source = 'https://example.invalid/'.padEnd(500, 'x')
    const value = formatScheduled(scheduled({ text: '<at type="all"/>' + 'x'.repeat(2000),
      source: { type: 'x_post', url: source } }), 'en-US', 'telegram')
    await encode(h.text(messageContent(value, 'telegram')))
    const payload = wire[0]!
    expect(h.unescape(payload.text)).toBe(value)
    expect(value).not.toContain(source)
    expect(value).toContain('Data source: https://codex-resets.com')
    expect(payload.text).not.toContain('&lt;at')
    expect(payload.text).not.toContain('<at')
  })

  it.each([true, false])('bounds proactive sends and retries on the original destination (private=%s)', async direct => {
    vi.useFakeTimers({ now: NOW })
    const { app, bot, wire, sendMessage } = await telegram()
    vi.spyOn(require('../lib/util').clock, 'sleep').mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(0)
    const current = session(bot, direct)
    expect((await current.execute({ name: 'codexresetsubscribe', args: [] }, true)).join('')).toContain('Subscription successful')
    const store = new KoishiStore(app)
    await enqueueReset(store, bot, direct)
    await enqueueReset(store, bot, direct, '😀<&'.repeat(2500))
    sendMessage.mockRejectedValueOnce(new Error('temporary adapter failure'))
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(wire).toHaveLength(3)
    expect(sendMessage).toHaveBeenCalledTimes(4)
    expect(wire.every(payload => payload.chat_id === (direct ? '200' : '-100123'))).toBe(true)
    expect(wire.every(payload => payload.message_thread_id === (direct ? undefined : 42))).toBe(true)
    expect((await app.database.get('codex_reset_delivery', {})).every(row => row.sentAt > 0)).toBe(true)
  })
})
