import { h, Argv, type Context, type Session } from 'koishi'
import { messageContent } from './messages'
import type { CodexApi } from './api'
import { formatOverview } from './format'
import { commandNames, languageNames, locales, parseLocale, text, type ActionName, type LanguageSetting, type Locale, type TextKey } from './locales'
import type { Monitor } from './monitor'
import { managementAccess, type QQGroupManager, type ManagementAccess } from './permissions'
import type { Reset, StatusResponse, Target } from './types'
import { errorText, targetKey } from './util'

interface CommandConfig { locale: LanguageSetting; qqGroupManagers?: QQGroupManager[] }
const accessMessages: Record<Exclude<ManagementAccess, 'allowed'>, TextKey> = {
  denied: 'adminOnly', unavailable: 'roleUnavailable', unsupported: 'groupUnsupported',
  qqNotConfigured: 'qqNotConfigured', qqNotAuthorized: 'qqNotAuthorized',
}
export const commandIds: Record<ActionName, string> = {
  status: 'codexresetstatus', subscribe: 'codexresetsubscribe', unsubscribe: 'codexresetunsubscribe',
}
const triggers = new Map<string, { action: ActionName; locale: Locale | null }>()
for (const action of Object.keys(commandNames) as ActionName[]) {
  for (const name of [commandIds[action], 'codex-reset.' + action, 'codex-reset ' + action]) {
    triggers.set(name, { action, locale: 'en-US' })
  }
  commandNames[action].forEach((alias, index) => {
    const key = alias.toLowerCase(), previous = triggers.get(key)
    triggers.set(key, { action, locale: previous && previous.locale !== locales[index] ? null : locales[index]! })
  })
}

export function parseInvocation(input: string | undefined) {
  if (typeof input !== 'string') return
  return triggers.get(input.trim().replace(/^\//, '').replace(/\s+/g, ' ').toLowerCase())
}

export function targetFromSession(session: Session | undefined): Target | undefined {
  if (!session?.platform || !session.selfId || typeof session.isDirect !== 'boolean') return
  const type = session.isDirect ? 'private' : 'channel'
  const targetId = session.isDirect ? session.userId : session.channelId
  if (!targetId) return
  if (session.platform === 'telegram' && type === 'channel' && !session.guildId) return
  const target = { platform: session.platform, selfId: session.selfId, type, targetId, guildId: session.guildId ?? '' } as const
  return { ...target, id: targetKey(target) }
}

export function registerCommands(ctx: Context, monitor: Monitor, api: Pick<CodexApi, 'status' | 'recent'>, wake: () => void, config: CommandConfig): void {
  for (const locale of locales) {
    ctx.i18n.define(locale, {
      'codex-resets': { locale },
      commands: Object.fromEntries((Object.keys(commandNames) as ActionName[]).map(action =>
        [commandIds[action], { description: text(locale, (action + 'Desc') as TextKey) }],
      )),
    })
  }
  const invocation = ({ session, name, command }: Argv) => {
    const { content, prefix } = session?.stripped ?? {}
    if (!content?.trim()) return parseInvocation(name ?? command?.name)
    // Read the command tokens, not its arguments, after Koishi has selected our command.
    // Keep this separate from the exact-match parser used to activate the fallback.
    const leadingInvocation = (input: string) => {
      const tokens = Argv.parse(input).tokens ?? []
      const parsed = parseInvocation(tokens.slice(0, 2).map(token => token.content).join(' '))
        ?? parseInvocation(tokens[0]?.content)
      return parsed && commandIds[parsed.action] === command?.name ? parsed : undefined
    }
    return leadingInvocation(prefix ? content.slice(prefix.length) : content) ?? leadingInvocation(content)
  }
  const invocationLocales = new WeakMap<Argv, Locale>()
  const inputLocale = (argv: Argv): Locale => invocationLocales.get(argv) ?? invocation(argv)?.locale
    ?? (argv.session ? parseLocale(argv.session.text('codex-resets.locale')) : undefined) ?? 'zh-CN'
  const outputLocale = (argv: Argv) => parseLocale(config.locale) ?? inputLocale(argv)
  const reply = (argv: Argv, key: TextKey, params: Record<string, string> = {}) => h.text(messageContent(text(outputLocale(argv), key, params), argv.session?.platform)).toString()

  ctx.before('command/execute', async (argv) => {
    const { command, session, args } = argv
    if (!command || !session || !Object.values(commandIds).includes(command.name)) return
    const parsed = invocation(argv)
    let locale = parsed?.locale
    if (parsed && !locale) {
      const target = targetFromSession(session)
      if (target) locale = await monitor.getLocale(target)
    }
    invocationLocales.set(argv, locale ?? parseLocale(session.text('codex-resets.locale')) ?? 'zh-CN')
    session.locales = [outputLocale(argv)]
    // Structured native interactions skip the token parser's per-session alias check.
    if (argv.name && ctx.$commander.get(argv.name, session) !== command) {
      return command.config.showWarning ? reply(argv, 'lowAuthority') : ''
    }
    if (session.user && !await ctx.permissions.test(['command:' + command.name], session)) {
      return command.config.showWarning ? reply(argv, 'lowAuthority') : ''
    }
    if (args?.length) return reply(argv, 'extraArguments')
    if (command.config.checkUnknown && Object.keys(argv.options ?? {}).some(key => !Object.hasOwn(command._options, key))) {
      return command.config.showWarning ? reply(argv, 'unknownOptions') : ''
    }
    if (command.name !== commandIds.status) {
      const access = await managementAccess(session, config.qqGroupManagers)
      if (access !== 'allowed') return reply(argv, accessMessages[access])
    }
  })

  for (const action of Object.keys(commandNames) as ActionName[]) {
    ctx.command(commandIds[action], {
      authority: 0, checkArgCount: true, checkUnknown: true,
      handleError: (_error, argv) => reply(argv, 'operationFailed'),
    }).alias(...new Set([...commandNames[action], 'codex-reset.' + action])).action(async (argv) => {
      const target = targetFromSession(argv.session)
      if (!target) return reply(argv, 'context')
      if (action === 'status') {
        const subscriptionLocale = await monitor.getLocale(target)
        let snapshot: StatusResponse | null = null, recent: Reset[] | null = null
        try { snapshot = await api.status() }
        catch (error) { ctx.logger('codex-resets').warn('Status query failed: %s', errorText(error)) }
        try { recent = (await api.recent()).data }
        catch (error) { ctx.logger('codex-resets').warn('Recent history query failed: %s', errorText(error)) }
        const platform = argv.session?.platform
        return h.text(messageContent(formatOverview(snapshot, recent, subscriptionLocale, Date.now(), outputLocale(argv), platform), platform)).toString()
      }
      if (action === 'subscribe') {
        const created = await monitor.subscribe(target, inputLocale(argv))
        wake()
        return reply(argv, created ? 'subscribed' : 'already', { language: languageNames[await monitor.getLocale(target) ?? outputLocale(argv)] })
      }
      return reply(argv, await monitor.unsubscribe(target) ? 'unsubscribed' : 'absent')
    })
  }

  // Validate the actual alias before entering Koishi's permission and context-filter lifecycle.
  ctx.middleware((session, next) => {
    if (session.stripped.hasAt && !session.stripped.appel || session.quote) return next()
    const found = parseInvocation(session.stripped.content)
    if (!found) return next()
    const name = session.stripped.content.trim().replace(/^\//, '').replace(/\s+/g, '.').toLowerCase()
    const command = ctx.$commander.get(name, session)
    if (command?.name !== commandIds[found.action]) return next()
    const alias = command._aliases[name]!
    return session.execute({ name, command, args: [...alias.args ?? []], options: { ...alias.options } }, next)
  })
}
