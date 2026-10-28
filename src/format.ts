import { languageNames, text, type Locale } from './locales'
import type { Notification, Reset, ScheduledReset, StatusResponse } from './types'
import { ExecutionIdentity, recentExecutions } from './execution'

// Etc/GMT uses the opposite sign: these are fixed UTC offsets, without daylight saving.
const timeZones: Record<Locale, { id: string; label: string }> = {
  'en-US': { id: 'UTC', label: 'UTC' },
  'zh-CN': { id: 'Etc/GMT-8', label: 'UTC+08:00' },
  'zh-TW': { id: 'Etc/GMT-8', label: 'UTC+08:00' },
  'ja-JP': { id: 'Etc/GMT-9', label: 'UTC+09:00' },
  'ko-KR': { id: 'Etc/GMT-9', label: 'UTC+09:00' },
}

export function formatTime(value: string, locale: Locale = 'zh-CN', includeZone = true): string {
  const timeZone = timeZones[locale]
  return new Intl.DateTimeFormat(locale, {
    timeZone: timeZone.id, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(value)) + (includeZone ? ` (${timeZone.label})` : '')
}

export function formatReset(reset: Reset, locale: Locale = 'zh-CN', platform = ''): string {
  return [
    text(locale, reset.reset_type === 'banked' ? 'bankedTitle' : 'resetTitle'), text(locale, 'resetNotice'),
    text(locale, 'recordedAt', { time: formatTime(reset.announced_at, locale) }),
    text(locale, 'attribution'),
  ].join('\n\n')
}

export function formatScheduled(reset: ScheduledReset, locale: Locale = 'zh-CN', platform = ''): string {
  return [
    text(locale, 'scheduledTitle'), text(locale, 'scheduledPushNotice'),
    [
      text(locale, 'resetType', { value: text(locale, reset.reset_type === 'banked' ? 'banked' : 'regular') }),
      text(locale, 'scheduledAt', { time: reset.scheduled_for ? formatTime(reset.scheduled_for, locale) : text(locale, 'noSchedule') }),
    ].join('\n'),
    text(locale, 'attribution'),
  ].join('\n\n')
}

export function formatNotification(payload: Notification, locale: Locale, platform = ''): string {
  if (payload.type === 'reset') return formatReset(payload.reset!, locale, platform)
  if (payload.type === 'scheduled') return formatScheduled(payload.scheduled!, locale, platform)
  throw new Error('Legacy forecast or diagnostic notifications cannot be sent')
}

function statusSections(response: StatusResponse, now: number, locale: Locale): string[] {
  const { scheduled_reset: scheduled, active_watch: watch } = response.data
  if (scheduled) {
    return [[
      text(locale, 'scheduled', { time: scheduled.scheduled_for ? formatTime(scheduled.scheduled_for, locale, false) : text(locale, 'noSchedule') }),
      text(locale, 'scheduledNotice'),
    ].join('\n')]
  }
  return [watch && Date.parse(watch.expires_at) > now ? [
    text(locale, 'activeWatch', {
      level: text(locale, watch.level), chance: watch.reset_chance_percent === null ? text(locale, 'unknown') : `${watch.reset_chance_percent}%`,
    }),
    text(locale, 'expires', { time: formatTime(watch.expires_at, locale, false) }),
    text(locale, 'forecastNotice'),
  ].join('\n') : text(locale, 'noWatch')]
}

export function formatOverview(response: StatusResponse | null, history: Reset[] | null, subscriptionLocale: Locale | undefined, now: number, locale: Locale, platform = ''): string {
  const sections = [text(locale, 'statusTitle'), ...(response ? statusSections(response, now, locale) : [text(locale, 'statusFailed')])]
  const lines = [text(locale, 'historyTitle')]
  if (history === null) {
    lines.push(text(locale, 'historyFailed'))
    // Preserve the known latest reset when only the history endpoint fails.
    const latest = response?.data.latest_reset
    if (latest) lines.push(text(locale, 'latest', {
      time: formatTime(latest.announced_at, locale, false), type: text(locale, latest.reset_type === 'banked' ? 'banked' : 'regular'),
    }))
  }
  else {
    const identity = new ExecutionIdentity()
    if (response?.data.latest_reset) identity.observe(response.data.latest_reset)
    const unique = recentExecutions(history, identity).slice(0, 3)
    if (!unique.length) lines.push(text(locale, 'noReset'))
    unique.forEach((reset, index) => lines.push(
      `${index + 1}. ${formatTime(reset.announced_at, locale, false)} — ${text(locale, reset.reset_type === 'banked' ? 'banked' : 'regular')}`,
    ))
  }
  sections.push(lines.join('\n'), text(locale, 'overviewTimeZone', { zone: timeZones[locale].label }), text(locale, subscriptionLocale ? 'subscription' : 'notSubscribed', {
    language: subscriptionLocale ? languageNames[subscriptionLocale] : '',
  }), text(locale, 'attribution'))
  return sections.join('\n\n')
}
