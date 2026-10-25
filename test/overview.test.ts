import { describe, expect, it } from 'vitest'
import { formatOverview, formatTime } from '../src/format'
import { languageNames, locales, text } from '../src/locales'
import { NOW, reset, scheduled, status, watch } from './helpers'

const history = ['2026-10-25T06:06:16Z', '2026-10-23T17:00:00Z', '2026-10-22T17:00:00Z']
  .map((announced_at, index) => reset({ id: String(index), announced_at, text: 'upstream quotation', source: { type: 'x_post', url: 'https://example.invalid/source' } }))
const now = Date.parse('2026-10-25T09:00:00Z')
const prediction = watch({ reset_chance_percent: 100, expires_at: '2026-10-25T10:02:32.201Z' })
const footer = `最近 3 次重置（公告／首次观察时间）：
1. 2026/10/25 14:06 — 常规重置
2. 2026/10/24 01:00 — 常规重置
3. 2026/10/23 01:00 — 常规重置

以上时间均为 UTC+08:00。

当前会话未订阅。
发送「重置订阅开启」接收重置预告和已执行重置提醒。

数据来源：https://codex-resets.com`

describe('compact reset status', () => {
  it.each([true, false])('matches the approved Chinese template (forecast=%s)', active => {
    const snapshot = status({ latest_reset: history[0], active_watch: active ? prediction : null })
    const forecast = active ? '重置预测：较高｜概率 100%\n有效期至：2026/10/25 18:02\n预测不代表已执行。' : '当前无有效重置预测。'
    expect(formatOverview(snapshot, history, undefined, now, 'zh-CN')).toBe(`【Codex 重置状态】\n\n${forecast}\n\n${footer}`)
  })

  it('shows only the announcement block when both signals exist, retaining history and subscription details', () => {
    const snapshot = status({ scheduled_reset: scheduled({ scheduled_for: '2026-10-25T10:41:23.321Z' }), active_watch: prediction })
    expect(formatOverview(snapshot, history, undefined, now, 'zh-CN')).toBe(
      `【Codex 重置状态】\n\n待执行公告：2026/10/25 18:41\n预定时间已到也不代表已完成，需等待执行证据。\n\n${footer}`,
    )
  })

  it.each(locales)('prioritizes announcements even without a scheduled time or after that time passes in %s', locale => {
    for (const scheduled_for of [null, new Date(NOW - 1).toISOString(), new Date(NOW + 60_000).toISOString()]) {
      for (const active_watch of [null, watch({ reset_chance_percent: 100 })]) {
        const snapshot = status({ scheduled_reset: scheduled({ scheduled_for }), active_watch })
        for (const subscriptionLocale of [undefined, locale]) {
          const output = formatOverview(snapshot, history, subscriptionLocale, NOW, locale)
          expect(output).toContain(text(locale, 'scheduled', {
            time: scheduled_for ? formatTime(scheduled_for, locale, false) : text(locale, 'noSchedule'),
          }))
          expect(output).toContain(text(locale, 'scheduledNotice'))
          expect(output).not.toContain(text(locale, 'forecastNotice'))
          expect(output).not.toContain(text(locale, 'noWatch'))
          expect(output).not.toContain('100%')
          expect(output.match(/UTC(?:\+[0-9]{2}:[0-9]{2})?/g)).toHaveLength(1)
        }
      }
    }
  })

  it.each(locales)('falls back to a valid forecast and then no forecast when the announcement is absent in %s', locale => {
    for (const expiresAt of [NOW + 1, NOW, NOW - 1, null]) {
      const active_watch = expiresAt === null ? null : watch({ expires_at: new Date(expiresAt).toISOString() })
      const snapshot = status({ scheduled_reset: null, active_watch })
      for (const subscriptionLocale of [undefined, locale]) {
        const output = formatOverview(snapshot, history, subscriptionLocale, NOW, locale)
        expect(output).not.toContain(text(locale, 'scheduledNotice'))
        if (expiresAt !== null && expiresAt > NOW) {
          expect(output).toContain(text(locale, 'activeWatch', { level: text(locale, 'elevated'), chance: '60%' }))
          expect(output).toContain(text(locale, 'forecastNotice'))
          expect(output).not.toContain(text(locale, 'noWatch'))
        } else {
          expect(output).toContain(text(locale, 'noWatch'))
          expect(output).not.toContain(text(locale, 'forecastNotice'))
        }
      }
    }
  })

  it.each(locales)('keeps forecast metadata, subscription language and one shared zone in %s', locale => {
    const forecast = watch({ reset_chance_percent: null, forecast_window: 'long window', text: 'upstream forecast' })
    const snapshot = status({ active_watch: forecast })
    const output = formatOverview(snapshot, history, 'ja-JP', NOW, locale)
    expect(output).toContain(text(locale, 'activeWatch', { level: text(locale, 'elevated'), chance: text(locale, 'unknown') }))
    expect(output).toContain(text(locale, 'expires', { time: formatTime(forecast.expires_at, locale, false) }))
    expect(output).toContain(text(locale, 'forecastNotice'))
    expect(output).toContain(text(locale, 'subscription', { language: languageNames['ja-JP'] }))
    expect(output.match(/UTC(?:\+[0-9]{2}:[0-9]{2})?/g)).toHaveLength(1)
    for (const omitted of ['upstream', 'long window', 'https://example.invalid/source', snapshot.meta.generated_at]) expect(output).not.toContain(omitted)
  })

  it.each([NOW, NOW - 1])('does not display a forecast that expired at %s', expiresAt => {
    const output = formatOverview(status({ active_watch: watch({ expires_at: new Date(expiresAt).toISOString() }) }), [], undefined, NOW, 'zh-CN')
    expect(output).toContain('当前无有效重置预测。')
    expect(output).not.toContain('有效期至')
  })

  it('preserves a real zero probability', () => {
    expect(formatOverview(status({ active_watch: watch({ reset_chance_percent: 0 }) }), [], undefined, NOW, 'zh-CN')).toContain('概率 0%')
  })

  it.each([null, new Date(NOW).toISOString()])('retains scheduled announcements without treating them as executed (%s)', scheduled_for => {
    const snapshot = status({ scheduled_reset: { ...reset(), status: 'scheduled', scheduled_for } })
    const output = formatOverview(snapshot, [], undefined, NOW + 1000, 'zh-CN')
    expect(output).toContain(scheduled_for ? '待执行公告：2026/10/25 12:00' : '待执行公告：未给出预定时间')
    expect(output).toContain(text('zh-CN', 'scheduledNotice'))
    expect(output).toContain(text('zh-CN', 'noReset'))
    expect(output).not.toContain('1. ')
  })

  it('retains available information on partial failures and distinguishes failed history from empty history', () => {
    const noStatus = formatOverview(null, history, undefined, now, 'zh-CN')
    expect(noStatus).toContain(text('zh-CN', 'statusFailed'))
    expect(noStatus).toContain('1. 2026/10/25 14:06')
    expect(noStatus).not.toContain(text('zh-CN', 'noWatch'))
    const noHistory = formatOverview(status({ latest_reset: history[0], active_watch: prediction }), null, undefined, now, 'zh-CN')
    expect(noHistory).toContain(text('zh-CN', 'historyFailed'))
    expect(noHistory).toContain('最近已执行：2026/10/25 14:06（常规重置）')
    expect(noHistory).toContain('概率 100%')
    expect(noHistory).not.toContain(text('zh-CN', 'noReset'))
    const empty = formatOverview(status({ latest_reset: null }), [], undefined, now, 'zh-CN')
    expect(empty).toContain(text('zh-CN', 'noReset'))
    expect(empty).not.toContain(text('zh-CN', 'historyFailed'))
  })
})
