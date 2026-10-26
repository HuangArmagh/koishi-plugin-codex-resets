import { Context, h, Schema, Universal } from 'koishi'
import { messageContent } from './messages'
import { CodexApi } from './api'
import { registerCommands } from './commands'
export { registerCommands, targetFromSession } from './commands'
import { commandNames, descriptions, languageNames, locales, text, type LanguageSetting } from './locales'
import { Monitor } from './monitor'
import { qqIdentityPattern, validateQQGroupManagers, type QQGroupManager } from './permissions'
import { defineModels, KoishiStore } from './store'
import { clock, errorText, hasResponseCode, Serial } from './util'

export const name = 'codex-resets'
export const inject = { required: ['database', 'http'] }
export const usage = Object.fromEntries(locales.map((locale, index) => [locale,
  text(locale, 'help', { commands: Object.values(commandNames).map(names => names[index]).join(' / ') })
  + '\n' + text(locale, 'timeZoneRule')
  + '\n' + text(locale, 'attribution'),
]))

export interface Config {
  locale: LanguageSetting
  pollIntervalMs: number
  requestTimeoutMs: number
  sendIntervalMs: number
  qqGroupManagers: QQGroupManager[]
}

export const defaults: Config = {
  locale: 'auto',
  pollIntervalMs: 300_000,
  requestTimeoutMs: 15_000,
  sendIntervalMs: 1000,
  qqGroupManagers: [],
}

export const Config: Schema<Config> = Schema.object({
  locale: Schema.union([
    Schema.const('auto').i18n(descriptions('auto')),
    ...locales.map(locale => Schema.const(locale).description(languageNames[locale])),
  ]).default('auto').i18n(descriptions('configLocale')),
  pollIntervalMs: Schema.number().min(60_000).max(86_400_000).step(1000).default(defaults.pollIntervalMs).i18n(descriptions('configPoll')),
  requestTimeoutMs: Schema.number().min(1000).max(60_000).default(defaults.requestTimeoutMs).i18n(descriptions('configTimeout')),
  sendIntervalMs: Schema.number().min(1000).max(60_000).default(defaults.sendIntervalMs).i18n(descriptions('configSend')),
  qqGroupManagers: Schema.array(Schema.object({
    selfId: Schema.string().pattern(qqIdentityPattern).required().i18n(descriptions('configQQSelf')),
    groupId: Schema.string().pattern(qqIdentityPattern).required().i18n(descriptions('configQQGroup')),
    userIds: Schema.array(Schema.string().pattern(qqIdentityPattern)).min(1).required().i18n(descriptions('configQQUsers')),
  })).default([]).i18n(descriptions('configQQManagers')),
})

export function apply(ctx: Context, input: Partial<Config> = {}): void {
  const config = { ...defaults, ...input }
  validateQQGroupManagers(config.qqGroupManagers)
  if (config.locale !== 'auto' && !locales.includes(config.locale)) throw new Error('Unsupported locale')
  if (!Number.isFinite(config.pollIntervalMs) || config.pollIntervalMs < 60_000) throw new Error('检查间隔不能低于 60 秒')
  if (!Number.isFinite(config.sendIntervalMs) || config.sendIntervalMs < 1000) throw new Error('发送间隔不能低于 1 秒')
  defineModels(ctx)
  const logger = ctx.logger(name)
  const controller = new AbortController()
  const store = new KoishiStore(ctx)
  const qqSendSlots = new Serial()
  let lastQQSentAt = -Infinity
  const api = new CodexApi(async (url, headers, signal) => {
    const response = await ctx.http(url, {
      method: 'GET', headers, signal, timeout: config.requestTimeoutMs,
      responseType: 'text', validateStatus: () => true,
    })
    // Text decoding also handles empty 304 bodies and non-JSON upstream error pages.
    let body: unknown = response.data
    if (response.status !== 304 && response.data) {
      try { body = JSON.parse(response.data) } catch { /* The API client reports the HTTP status. */ }
    }
    return { status: response.status, headers: response.headers, body }
  }, { cacheMs: config.pollIntervalMs, signal: controller.signal, stateStore: store })

  const monitor = new Monitor(store, api, async (target, content) => {
    const bot = ctx.bots.find(bot => bot.platform === target.platform && bot.selfId === target.selfId)
    // The official console sandbox has no network login and stays in CONNECT.
    const sandboxReady = bot?.adapterName === 'sandbox' && bot.hidden
      && bot.platform?.startsWith('sandbox:') && bot.status === Universal.Status.CONNECT
    if (!bot || (bot.status !== Universal.Status.ONLINE && !sandboxReady)) throw new Error('订阅使用的机器人当前不在线')
    if (target.platform === 'telegram' && target.type === 'channel' && !target.guildId) {
      throw new Error('Telegram 群订阅缺少所属群信息，已暂停该会话的推送')
    }
    const session = target.platform === 'telegram' && target.type === 'channel' ? bot.session({
      type: 'send', guild: { id: target.guildId },
      channel: { id: target.targetId, type: Universal.Channel.Type.TEXT },
    }) : target.platform === 'qq' && target.type === 'private' ? bot.session({
      type: 'send', channel: { id: target.targetId, type: Universal.Channel.Type.DIRECT },
    }) : undefined
    // Satori's private helper retains only the channel ID from createDirectChannel.
    // QQ's encoder needs the DIRECT session to select its private API endpoint.
    const send = async (value: string) => {
      const message = h.text(messageContent(value, target.platform))
      const submit = () => target.type === 'private'
        ? bot.sendPrivateMessage(target.targetId, message, target.guildId || undefined, session ? { session } : undefined)
        : bot.sendMessage(target.targetId, message, undefined, session ? { session } : undefined)
      const pending = target.platform === 'qq' ? await qqSendSlots.run(async () => {
        // Include URL fallbacks in the same pacing budget: <=20 requests/minute.
        const delay = Math.max(config.sendIntervalMs, 3100) - (clock.now() - lastQQSentAt)
        if (delay > 0) await clock.sleep(delay, controller.signal)
        controller.signal.throwIfAborted()
        const current = await store.subscription(target.id)
        if (!current || current.generation !== target.generation) throw new Error('订阅已变更，取消排队发送')
        lastQQSentAt = clock.now()
        const completion = submit()
        // Reserve submission order only; a slow HTTP call must not hold this lock.
        void completion.catch(() => undefined)
        return { completion }
      }) : { completion: submit() }
      const ids = await pending.completion
      if (!ids?.length) throw new Error('适配器没有返回成功发送的消息 ID')
    }
    try { await send(content) }
    catch (error) {
      // Preserve URLs normally. Only a concrete QQ URL rejection allows this fallback.
      if (target.platform !== 'qq' || !hasResponseCode(error, 40054010) || !content.includes('https://codex-resets.com')) throw error
      logger.warn('QQ 主动消息拒绝 URL，将保留来源名称重试一次：%s', errorText(error))
      await send(content.replaceAll('https://codex-resets.com', 'Codex Resets'))
    }
  }, {
    locale: config.locale, sendDelayMs: config.sendIntervalMs, signal: controller.signal,
    report: (message, error) => logger.warn('%s：%s', message, errorText(error)),
  })

  let cancelTimer: (() => void) | undefined
  let nextCycleAt = Infinity
  let running = false
  let requested = false
  const cycle = async () => {
    cancelTimer?.()
    cancelTimer = undefined
    nextCycleAt = Infinity
    if (controller.signal.aborted) return
    if (running) { requested = true; return }
    running = true
    try {
      monitor.invalidateAnnouncements()
      // Refresh and invalidate obsolete announcements before delivering queued retries.
      try {
        // Recover known response state even while upstream requests remain in backoff.
        await api.flushState()
        if (Date.now() >= api.retryAt) await monitor.poll()
      } catch (error) {
        if (!controller.signal.aborted) logger.warn('状态同步未完成：%s', errorText(error))
      }
      await monitor.drain()
    } catch (error) {
      if (!controller.signal.aborted) logger.warn('检查未完成：%s', errorText(error))
    } finally {
      running = false
      if (!controller.signal.aborted) {
        const delay = requested ? 1000 : config.pollIntervalMs
        requested = false
        schedule(delay)
      }
    }
  }
  const schedule = (delay: number) => {
    const deadline = Date.now() + delay
    // Coalesce wake requests without postponing an earlier wake or periodic check.
    if (cancelTimer && nextCycleAt <= deadline) return
    cancelTimer?.()
    nextCycleAt = deadline
    cancelTimer = ctx.setTimeout(() => { void cycle() }, delay)
  }
  const wake = () => {
    if (controller.signal.aborted) return
    if (running) { requested = true; return }
    schedule(1000)
  }
  registerCommands(ctx, monitor, api, wake, config)
  ctx.on('ready', () => { void cycle() })
  ctx.on('dispose', () => {
    controller.abort()
    cancelTimer?.()
  })
}
