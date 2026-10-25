import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { App as KoishiApp } from 'koishi'
import type { Delivery, Subscription } from '../src/types'
import { makeApi, makeClock, MemoryStore, NOW, reset, status, target, watch, scheduled } from './helpers'

const require = createRequire(import.meta.url)
const { App, h, MessageEncoder, Universal } = require('koishi') as typeof import('koishi')
const Memory = require('@minatojs/driver-memory').default
const Mock = require('@koishijs/plugin-mock').default
const plugin = require('../lib/index') as typeof import('../src/index')
const { Monitor, scheduledKey } = require('../lib/monitor') as typeof import('../src/monitor')
const { KoishiStore, defineModels } = require('../lib/store') as typeof import('../src/store')
const { hash } = require('../lib/util') as typeof import('../src/util')
const { locales, commandNames, languageNames, text } = require('../lib/locales') as typeof import('../src/locales')
const { formatScheduled, formatReset, formatOverview, formatTime } = require('../lib/format') as typeof import('../src/format')
const { messageContent } = require('../lib/messages') as typeof import('../src/messages')
const messageText = (value: string, platform: string) => h.text(messageContent(value, platform))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
// Matches the official Discord adapter's text sanitizer, independently of plugin helpers.
const discordEncode = (value: string) => value.replace(/[\\*_\u0060~|()\[\]]/g, '\\$&')
  .replace(/@everyone/g, () => '\\@everyone').replace(/@here/g, () => '\\@here')
const wireText = (value: import('koishi').h.Fragment) => h.normalize(value).map(node => discordEncode(node.attrs.content)).join('')
const activeMention = /<@(?:!|&)?\d+>|@everyone|@here/
const mentions = '<@123456789012345678> <@!123456789012345678> <@&123456789012345679> @everyone @here'
const longText = ('**quota** [reset](details) 😀 ' + mentions + '\n').repeat(80)
const longUrl = 'https://example.invalid/' + '_'.repeat(2500)
function commandSession(app: KoishiApp, content?: string, direct = false) {
  const session = app.bots[0]!.session({ type: 'interaction/command', platform: 'discord', user: { id: '200' },
    guild: direct ? undefined : { id: 'guild-a' }, channel: { id: 'channel-a', type: direct ? Universal.Channel.Type.DIRECT : Universal.Channel.Type.TEXT } })
  if (content) session.content = content
  return session
}
async function start(app: KoishiApp, mock: { dispose(): unknown }) {
  await app.start()
  const bot = app.bots[0]!
  bot.platform = 'discord'
  bot.internal = { getGuild: async () => ({ id: 'guild-a', owner_id: '200' }) }
  cleanups.push(async () => { bot.platform = 'mock'; await mock.dispose(); await app.stop() })
  return bot
}
async function setup() {
  const app = new App({ prefix: '!' })
  app.plugin(Memory)
  const mock = app.plugin(Mock), clock = makeClock(), { api, state } = makeApi(status({ scheduled_reset: scheduled() }))
  const send = vi.fn(async (_target: unknown, _content: string) => {})
  let store!: InstanceType<typeof KoishiStore>, monitor!: InstanceType<typeof Monitor>
  app.plugin({ inject: ['database'], apply(ctx) {
    defineModels(ctx); store = new KoishiStore(ctx)
    monitor = new Monitor(store, api, send, { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
    plugin.registerCommands(ctx, monitor, api, () => {}, plugin.defaults)
  } })
  await start(app, mock)
  return { app, clock, api, state, send, store, monitor }
}

describe('announcement identity and Discord output', () => {
  it('does not resend the same announcement across metadata edits and reloads', async () => {
    const store = new MemoryStore(), clock = makeClock(), { api, state } = makeApi(status({ scheduled_reset: scheduled() }))
    const send = vi.fn(async () => {})
    const create = () => new Monitor(store, api, send, { clock, sendDelayMs: 1000, signal: new AbortController().signal, report: vi.fn() })
    await create().subscribe(target())
    for (const announced_at of ['2026-10-25T03:59:00.000Z', '2026-10-25T11:59:00+08:00']) {
      state.current = status({ scheduled_reset: scheduled({ announced_at }) })
      await create().poll()
      clock.advance(60_000)
    }
    expect(send).toHaveBeenCalledTimes(1)
    expect(store.deliveries.size).toBe(1)
    state.current = status({ scheduled_reset: scheduled({ id: 'another-announcement' }) })
    await create().poll()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('neutralizes native Discord mentions in a real status command response', async () => {
    const { app, api } = await setup()
    api.recent.mockResolvedValue({ data: [reset({ text: mentions })], pagination: { has_more: false, next_cursor: null } })
    const response = await commandSession(app).execute({ name: 'codexresetstatus', args: [], options: {} }, true)
    expect(response.every(node => node.type === 'text')).toBe(true)
    expect(wireText(response)).not.toMatch(activeMention)
  })

  it.each(locales)('keeps essential status/history fields and one localized reply with oversized upstream data in %s', async locale => {
    const { app, api, state } = await setup()
    const history = [0, 1, 2].map(index => reset({ id: String(index), text: longText,
      reset_type: 'banked', source: { type: 'x_post', url: 'https://example.invalid/' + 'a'.repeat(127) } }))
    state.current = status({ active_watch: watch(), scheduled_reset: { ...reset(), status: 'scheduled', scheduled_for: new Date(NOW).toISOString() } })
    api.recent.mockResolvedValue({ data: history, pagination: { has_more: false, next_cursor: null } })
    const index = locales.indexOf(locale)
    const run = async (action: 'status' | 'subscribe' | 'unsubscribe') => commandSession(app, commandNames[action][index])
      .execute({ name: 'codexreset' + action, args: [], options: {} }, true)
    const subscribed = await run('subscribe')
    expect(subscribed).toHaveLength(1)
    expect(wireText(subscribed)).toBe(discordEncode(text(locale, 'subscribed', { language: languageNames[locale] })))
    const response = await run('status')
    expect(response).toHaveLength(1)
    expect(wireText(response).length).toBeLessThanOrEqual(2000)
    expect(wireText(response)).not.toMatch(activeMention)
    const overview = formatOverview(state.current, history, locale, NOW, locale, 'discord')
    const encoded = wireText(messageText(overview, 'discord'))
    expect(encoded).toContain(discordEncode(text(locale, 'subscription', { language: languageNames[locale] })))
    expect(encoded).toContain(discordEncode(text(locale, 'scheduledNotice')))
    for (const position of [1, 2, 3]) expect(encoded).toContain(position + '. ')
    expect(encoded).toContain(discordEncode(text(locale, 'attribution')))
    const cancelled = await run('unsubscribe')
    expect(cancelled).toHaveLength(1)
    expect(wireText(cancelled)).toBe(discordEncode(text(locale, 'unsubscribed')))
  })

  it.each(locales)('retains announcement/reset metadata and attribution within Discord limits in %s', locale => {
    const prediction = scheduled({ text: longText, source: { type: 'x_post', url: longUrl } })
    const executed = reset({ text: longText, source: prediction.source })
    const forecast = wireText(messageText(formatScheduled(prediction, locale, 'discord'), 'discord'))
    const confirmation = wireText(messageText(formatReset(executed, locale, 'discord'), 'discord'))
    for (const output of [forecast, confirmation]) {
      expect(output.length).toBeLessThanOrEqual(2000)
      expect(output).not.toMatch(activeMention)
      expect(output).not.toContain('https://example.invalid/')
      expect(output).not.toContain('…')
      expect(output).toContain(discordEncode(text(locale, 'attribution')))
    }
    expect(forecast).toContain(discordEncode(text(locale, 'scheduledPushNotice')))
    expect(forecast).toContain(discordEncode(text(locale, 'scheduledAt', { time: formatTime(prediction.scheduled_for!, locale) })))
    expect(confirmation).toContain(discordEncode(text(locale, 'recordedAt', { time: formatTime(executed.announced_at, locale) })))
    const shortUrl = 'https://example.invalid/reset'
    expect(wireText(messageText(formatScheduled(scheduled({ source: { type: 'observed', url: shortUrl } }), locale, 'discord'), 'discord'))).not.toContain(shortUrl)
  })

  it.each(['a'.repeat(2000), '_'.repeat(1000), '😀'.repeat(1000), '['.repeat(999) + '😀',
    'x'.repeat(1999) + '😀', '_'.repeat(1001), mentions.repeat(100)])('counts adapter escaping and preserves Unicode at the final boundary (%#)', value => {
    const output = messageText(value, 'discord')
    const raw = output.attrs.content as string
    expect(output.type).toBe('text')
    expect(raw.isWellFormed()).toBe(true)
    expect(wireText(output).length).toBeLessThanOrEqual(2000)
    expect(wireText(output)).not.toMatch(activeMention)
    expect(messageText(raw, 'discord').attrs.content).toBe(raw)
    if (discordEncode(value).length <= 2000 && !activeMention.test(value)) expect(raw).toBe(value)
    else expect(raw.endsWith('…')).toBe(true)
  })

  it('keeps Koishi markup as text and leaves unrestricted platforms unchanged', () => {
    const value = mentions + '<at type="all"/><image src="https://example.invalid/image"/>' + longText
    const response = h.parse(messageText(value, 'discord').toString())
    expect(response).toHaveLength(1)
    expect(response[0]!.type).toBe('text')
    expect(wireText(response)).not.toMatch(activeMention)
    for (const platform of ['onebot', 'sandbox:test']) {
      expect(messageText(value, platform).attrs.content).toBe(value)
      const prediction = scheduled({ text: longText, source: { type: 'observed', url: longUrl } })
      expect(formatScheduled(prediction, 'en-US', platform)).toBe(formatScheduled(prediction, 'en-US'))
    }
  })

  it.each([false, true])('bounds real proactive Discord sends and retries, including queued legacy text (private=%s)', async direct => {
    vi.useFakeTimers({ now: NOW })
    const app = new App()
    app.plugin(Memory)
    const mock = app.plugin(Mock)
    app.http = vi.fn(async () => ({ status: 200, headers: new Headers(), data: JSON.stringify(status({
      scheduled_reset: scheduled({ text: longText, source: { type: 'observed', url: longUrl } }),
    })) })) as unknown as typeof app.http
    app.plugin(plugin, { pollIntervalMs: 60_000 })
    const bot = await start(app, mock)
    vi.spyOn(require('../lib/util').clock, 'sleep').mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(0)
    const sent: string[] = [], rejected: string[] = []
    let transient = true
    class DiscordWireEncoder extends MessageEncoder {
      buffer = ''
      async visit(element: import('koishi').h) { this.buffer += discordEncode(element.attrs.content ?? '') }
      async flush() {
        if (this.buffer.length > 2000 || activeMention.test(this.buffer)) { rejected.push(this.buffer); throw new Error('invalid outbound content') }
        if (transient) { transient = false; throw new Error('temporary adapter failure') }
        sent.push(this.buffer); this.results.push({ id: 'message-' + sent.length })
      }
    }
    vi.spyOn(bot, 'sendMessage').mockImplementation(async (channel, content, referrer, options) =>
      (await new DiscordWireEncoder(bot, channel, referrer, options).send(content)).map(row => row.id!))
    vi.spyOn(bot, 'sendPrivateMessage').mockImplementation(async (_user, content) =>
      (await new DiscordWireEncoder(bot, 'private-channel').send(content)).map(row => row.id!))
    const session = commandSession(app, undefined, direct)
    const replies = await session.execute({ name: 'codexresetsubscribe', args: [], options: {} }, true)
    expect(replies).toHaveLength(1)
    const store = new KoishiStore(app), subscription = (await store.subscriptions())[0]!
    await store.enqueue({ id: 'legacy', subscriptionId: subscription.id, generation: subscription.generation,
      eventKey: 'reset:regular:legacy', kind: 'reset', payload: null, content: longText,
      createdAt: NOW, expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0 })
    await store.enqueue({ id: 'executed', subscriptionId: subscription.id, generation: subscription.generation,
      eventKey: 'reset:regular:executed', kind: 'reset', payload: { type: 'reset', reset: reset({ text: longText,
        source: { type: 'observed', url: longUrl } }) }, content: '',
      createdAt: NOW, expiresAt: 0, retryAt: 0, attempts: 0, sentAt: 0 })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(rejected).toHaveLength(0)
    expect(sent).toHaveLength(3)
    expect(sent.every(value => value.length <= 2000 && !activeMention.test(value))).toBe(true)
    expect(sent.some(value => value.includes('Data source: https://codex-resets.com'))).toBe(true)
    expect((await app.database.get('codex_reset_delivery', {})).every(row => row.sentAt > 0)).toBe(true)
  })
})


async function seedWatch(app: KoishiApp, shape: 'kind' | 'key' | 'payload', sentAt = 0) {
  const destination = target()
  const subscription: Subscription = { ...destination, generation: 'saved-generation', subscribedAt: NOW - 7200_000,
    baselined: true, baselineResetKey: 'reset:regular:' + reset().id, pendingResets: [], locale: 'en-US' }
  await app.database.create('codex_reset_subscription', subscription)
  const old: Delivery = { id: 'legacy-forecast', subscriptionId: subscription.id, generation: subscription.generation,
    eventKey: shape === 'key' ? 'watch:legacy' : 'legacy', kind: shape === 'kind' ? 'watch' : 'reset', content: 'saved prediction',
    payload: shape === 'payload' ? { type: 'watch', watch: watch() } : null,
    createdAt: NOW - 60_000, expiresAt: NOW + 3600_000, attempts: 3, retryAt: NOW + 30_000, sentAt }
  await app.database.create('codex_reset_delivery', old)
  const eventKey = scheduledKey(scheduled())
  const kept: Delivery = { ...old, id: hash([subscription.id, subscription.generation, eventKey]), eventKey, kind: 'scheduled',
    payload: { type: 'scheduled', scheduled: scheduled() }, expiresAt: 0, sentAt: NOW - 10_000 }
  await app.database.create('codex_reset_delivery', kept)
  return { old, subscription, kept }
}

describe('forecast retirement on upgrade', () => {
  it.each((['kind', 'key', 'payload'] as const).flatMap(shape => [0, NOW - 10_000].map(sentAt => ({ shape, sentAt }))))(
    'discards legacy forecasts detected by $shape with sentAt=$sentAt and preserves announcement deduplication', async ({ shape, sentAt }) => {
      const { app, store, monitor, send, clock, api } = await setup()
      const { kept, subscription } = await seedWatch(app, shape, sentAt)
      await store.subscriptions()
      expect(await app.database.get('codex_reset_delivery', {})).toEqual([kept])
      expect(await store.subscription(subscription.id)).toEqual({ ...subscription, baselineExecutionKeys: [subscription.baselineResetKey] })
      clock.advance(60_000)
      await monitor.poll()
      await new Monitor(new KoishiStore(app), api, send, { clock, sendDelayMs: 1000,
        signal: new AbortController().signal, report: vi.fn() }).poll()
      expect(send).not.toHaveBeenCalled()
    },
  )

  it('blocks delivery and resumes forecast cleanup after a failed database removal', async () => {
    const { app, store, monitor, send, api } = await setup()
    const { old, kept } = await seedWatch(app, 'kind')
    const original = app.database.remove.bind(app.database)
    let fail = true
    vi.spyOn(app.database, 'remove').mockImplementation(async (...args: any[]) => {
      if (fail && args[0] === 'codex_reset_delivery') throw new Error('migration interrupted')
      return original(...args as [never, never])
    })
    await expect(monitor.poll()).rejects.toThrow('migration interrupted')
    await expect(store.pending(NOW)).rejects.toThrow('migration interrupted')
    expect(send).not.toHaveBeenCalled()
    expect(api.status).not.toHaveBeenCalled()
    expect(await app.database.get('codex_reset_delivery', { id: old.id })).toHaveLength(1)
    fail = false
    await new KoishiStore(app).subscriptions()
    await store.pending(NOW)
    expect(await app.database.get('codex_reset_delivery', {})).toEqual([kept])
    await monitor.poll()
    expect(send).not.toHaveBeenCalled()
  })
})
