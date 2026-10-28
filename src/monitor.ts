import { randomUUID } from 'node:crypto'
import { formatNotification, formatReset, formatScheduled } from './format'
import { parseLocale, type LanguageSetting, type Locale } from './locales'
import type { Api, Clock, Delivery, Notification, Reset, ScheduledReset, Store, Subscription, Target } from './types'
import { clock as systemClock, hash, Serial } from './util'

export function resetKey(reset: Reset): string {
  return `reset:${reset.reset_type}:${reset.id}`
}

function executionKeys(reset: Reset): string[] {
  const keys = [resetKey(reset)]
  // Observed executions can refer back to the numeric announcement ID. Keep the
  // original delivery key: changing it would replay notifications after an upgrade.
  const observed = reset.source.type === 'observed' && /^observed-([0-9]+)$/.exec(reset.id)
  if (observed) keys.push(`reset:${reset.reset_type}:${observed[1]}`)
  return keys
}

export function scheduledKey(reset: ScheduledReset): string {
  return `scheduled:${reset.reset_type}:${reset.id}`
}

export type SubmitDelivery = (submit: (target: Subscription, content: string) => Promise<void>) => Promise<{ completion: Promise<void> } | undefined>

export class Monitor {
  private readonly mutations = new Serial()
  private pollTask?: Promise<void>
  private drainTask?: Promise<void>
  private drainRequested = false
  private readonly inFlight = new Map<string, Promise<void>>()
  private lastSentAt = -Infinity
  private activeScheduled: { key: string; value: ScheduledReset } | null | undefined

  constructor(
    private readonly store: Store,
    private readonly api: Api,
    private readonly send: (target: Subscription, content: string, submitCurrent: SubmitDelivery) => Promise<void | boolean>,
    private readonly options: {
      sendDelayMs: number
      signal: AbortSignal
      report: (message: string, error: unknown) => void
      clock?: Clock
      locale?: LanguageSetting
    },
  ) {}

  private get clock(): Clock { return this.options.clock ?? systemClock }

  localeFor(subscription: Subscription): Locale {
    return parseLocale(this.options.locale) ?? parseLocale(subscription.locale) ?? 'zh-CN'
  }

  async getLocale(target: Target): Promise<Locale | undefined> {
    const subscription = await this.store.subscription(target.id)
    return subscription ? this.localeFor(subscription) : undefined
  }

  subscribe(target: Target, locale: Locale = 'zh-CN'): Promise<boolean> {
    return this.mutations.run(async () => {
      const existing = await this.store.subscription(target.id)
      if (existing) {
        if (existing.locale !== locale) await this.store.saveSubscription({ ...existing, locale })
        return false
      }
      // Capture known executions inside the same lock as polling and registration.
      // A per-generation snapshot preserves ordering even within one millisecond.
      const baselineExecutionKeys = await this.store.executionKeys()
      await this.store.saveSubscription({
        ...target, locale, generation: randomUUID(), subscribedAt: this.clock.now(), baselined: false,
        baselineResetKey: '', baselineExecutionKeys, pendingResets: [],
      })
      return true
    })
  }

  unsubscribe(target: Target): Promise<boolean> {
    return this.mutations.run(async () => {
      if (!await this.store.subscription(target.id)) return false
      await this.store.deleteSubscription(target.id)
      return true
    })
  }

  async isSubscribed(target: Target): Promise<boolean> {
    return Boolean(await this.store.subscription(target.id))
  }

  poll(): Promise<void> {
    if (!this.pollTask) this.pollTask = this.check().finally(() => { this.pollTask = undefined })
    return this.pollTask
  }

  invalidateAnnouncements(): void {
    this.activeScheduled = undefined
  }

  private async check(): Promise<void> {
    this.options.signal.throwIfAborted()
    // Block already-read retry batches until this refresh has validated the announcement.
    this.invalidateAnnouncements()
    const initialSubscriptions = await this.store.subscriptions()
    if (!initialSubscriptions.length) return
    const initialGenerations = new Map(initialSubscriptions.map(subscription => [subscription.id, subscription.generation]))
    const newSubscriptions = initialSubscriptions.filter(subscription => !subscription.baselined)
    const checkpoint = await this.store.checkpoint()
    // A snapshot requested before registration cannot establish the new subscription's baseline.
    const status = await this.api.status(Math.max(0, ...newSubscriptions.map(subscription => subscription.subscribedAt)))
    this.options.signal.throwIfAborted()
    const latest = status.data.latest_reset
    const scheduled = status.data.scheduled_reset
    const latestKeys = new Set(latest ? executionKeys(latest) : [])
    const pendingResetKey = scheduled ? resetKey(scheduled) : null
    const activeScheduled = scheduled && !latestKeys.has(pendingResetKey!)
      && !await this.store.hasExecution(pendingResetKey!)
      ? { key: scheduledKey(scheduled), value: scheduled }
      : null
    const pendingResets = await this.mutations.run(async () => {
      this.options.signal.throwIfAborted()
      await this.store.cancelScheduledExcept(activeScheduled?.key ?? null)
      const subscriptions = (await this.store.subscriptions())
        .filter(subscription => initialGenerations.get(subscription.id) === subscription.generation)
      for (const subscription of subscriptions) {
        if (activeScheduled && scheduled && pendingResetKey && !(subscription.pendingResets ?? []).some(pending => pending.key === pendingResetKey)) {
          subscription.pendingResets = [...(subscription.pendingResets ?? []), { key: pendingResetKey, announcedAt: scheduled.announced_at }]
          // Persist observations before history requests, so failures and reloads cannot erase them.
          await this.store.saveSubscription(subscription)
        }
      }
      return subscriptions.flatMap(subscription => subscription.pendingResets ?? [])
    })
    const resets = new Map<string, Reset>()
    if (latest) resets.set(resetKey(latest), latest)
    let historyComplete = true

    const earliestSubscription = Math.min(...initialSubscriptions.map(subscription => subscription.subscribedAt))
    const needsInitialCatchup = latest && ((!checkpoint && Date.parse(latest.announced_at) >= earliestSubscription)
      || newSubscriptions.some(subscription => Date.parse(latest.announced_at) >= subscription.subscribedAt))
    const unconfirmed = pendingResets.filter(pending => !latestKeys.has(pending.key))
    const unresolved = unconfirmed.filter(pending => !activeScheduled || pending.key !== pendingResetKey)
    if (unresolved.length || (latest && (needsInitialCatchup || (checkpoint && checkpoint.latestResetKey !== resetKey(latest))))) {
      const previousTime = checkpoint?.latestResetAt ? Date.parse(checkpoint.latestResetAt) : checkpoint?.checkedAt ?? earliestSubscription
      const from = new Date(Math.min(
        Math.max(previousTime, earliestSubscription),
        // History filters by announcement time. A still-listed current announcement
        // may already have executed, so required catch-up must cover its original time too.
        ...unconfirmed.map(pending => Date.parse(pending.announcedAt)),
        ...(needsInitialCatchup ? newSubscriptions.map(subscription => subscription.subscribedAt) : []),
      )).toISOString()
      let cursor: string | undefined
      const visited = new Set<string>()
      try {
        // A bounded catch-up avoids an endless traversal of an invalid upstream cursor chain.
        for (let page = 0; ; page++) {
          if (page >= 20) throw new Error('历史补查超过 2000 条，检查点已保留，需检查上游分页')
          this.options.signal.throwIfAborted()
          const result = await this.api.history(from, cursor)
          for (const reset of result.data) resets.set(resetKey(reset), reset)
          if (!result.pagination.has_more) break
          const next = result.pagination.next_cursor
          if (!next || visited.has(next)) throw new Error('历史接口返回了无效或重复的分页游标')
          visited.add(next)
          cursor = next
        }
      } catch (error) {
        if (this.options.signal.aborted) throw error
        historyComplete = false
        this.options.report('历史补查失败，将保留检查点供下次继续检查', error)
      }
    }

    await this.mutations.run(async () => {
      this.options.signal.throwIfAborted()
      const subscriptions = await this.store.subscriptions()
      const ordered = [...resets.values()].sort((left, right) => Date.parse(left.announced_at) - Date.parse(right.announced_at))
      const confirmedKeys = new Set(ordered.flatMap(executionKeys))
      // Evidence is global and outlives subscriptions, notification queues and checkpoints.
      // Persist it before allowing announcements or committing catch-up progress.
      await this.store.saveExecutions([...confirmedKeys])
      // Execution evidence wins if status/history temporarily contain the same announcement.
      if (pendingResetKey && confirmedKeys.has(pendingResetKey)) {
        await this.store.cancelScheduledExcept(null)
        this.activeScheduled = null
      } else {
        this.activeScheduled = historyComplete && (this.api.retryAt ?? 0) <= this.clock.now() ? activeScheduled : undefined
      }
      for (const subscription of subscriptions) {
        // Subscriptions created while the snapshot was in flight need their own fresh baseline.
        if (initialGenerations.get(subscription.id) !== subscription.generation) continue
        const pendingKeys = new Set((subscription.pendingResets ?? []).map(pending => pending.key))
        const baselineExecutions = new Set(subscription.baselineExecutionKeys ?? [])
        const wasBaselined = subscription.baselined
        let subscriptionChanged = false
        if (!wasBaselined) {
          // A global checkpoint may already be ahead of this subscription; keep its initial catch-up retryable.
          subscription.baselined = historyComplete
          subscription.baselineResetKey = latest && Date.parse(latest.announced_at) < subscription.subscribedAt
            && ![...latestKeys].some(key => pendingKeys.has(key)) ? resetKey(latest) : ''
          subscriptionChanged = true
        }
        for (const reset of ordered) {
          const key = resetKey(reset)
          const keys = executionKeys(reset)
          if (keys.some(key => key === subscription.baselineResetKey || baselineExecutions.has(key))) continue
          // Execution may be observed after subscription while retaining an older announcement time.
          if (Date.parse(reset.announced_at) < subscription.subscribedAt
            && !keys.some(key => pendingKeys.has(key))
            && (!wasBaselined || !latest || key !== resetKey(latest))) continue
          await this.enqueue(subscription, key, 'reset', formatReset(reset, this.localeFor(subscription), subscription.platform), 0, { type: 'reset', reset })
        }
        if (this.activeScheduled) {
          await this.enqueue(subscription, this.activeScheduled.key, 'scheduled', formatScheduled(this.activeScheduled.value, this.localeFor(subscription), subscription.platform), 0, { type: 'scheduled', scheduled: this.activeScheduled.value })
        }
        if ((subscription.pendingResets ?? []).some(pending => confirmedKeys.has(pending.key))) {
          subscription.pendingResets = subscription.pendingResets!.filter(pending => !confirmedKeys.has(pending.key))
          subscriptionChanged = true
        }
        // Commit progress only after every eligible delivery is durable; retries use the same delivery IDs.
        if (subscriptionChanged) await this.store.saveSubscription(subscription)
      }
      if (historyComplete) await this.store.saveCheckpoint({
        latestResetKey: latest ? resetKey(latest) : null,
        latestResetAt: latest?.announced_at ?? null,
        checkedAt: this.clock.now(),
      })
    })
    await this.drain()
  }

  private async enqueue(subscription: Subscription, eventKey: string, kind: Delivery['kind'], content: string, expiresAt: number, payload: Notification): Promise<void> {
    await this.store.enqueue({
      id: hash([subscription.id, subscription.generation, eventKey]),
      subscriptionId: subscription.id,
      generation: subscription.generation,
      eventKey, kind, content, expiresAt, payload,
      createdAt: this.clock.now(), retryAt: 0, attempts: 0, sentAt: 0,
    })
  }

  drain(): Promise<void> {
    this.drainRequested = true
    if (!this.drainTask) this.drainTask = (async () => {
      do {
        this.drainRequested = false
        await this.deliver()
      } while (this.drainRequested)
    })().finally(() => { this.drainTask = undefined })
    return this.drainTask
  }

  private async deliver(): Promise<void> {
    for (let delivery of await this.store.pending(this.clock.now())) {
      this.options.signal.throwIfAborted()
      // An unknown adapter outcome must not be retried or overtaken in the same conversation.
      if (this.inFlight.has(delivery.subscriptionId)) continue
      // Upgrades must not send forecasts or diagnostics queued by previous releases.
      if (delivery.kind === 'watch' || delivery.eventKey.startsWith('watch:') || delivery.payload?.type === 'watch'
        || delivery.eventKey.startsWith('test:') || delivery.payload?.type === 'test') {
        await this.store.deleteDelivery(delivery.id)
        continue
      }
      const delay = this.options.sendDelayMs - (this.clock.now() - this.lastSentAt)
      if (delay > 0) await this.clock.sleep(delay, this.options.signal)
      const attempt = await this.mutations.run(async () => {
        if (this.inFlight.has(delivery.subscriptionId)) return
        const prepared = await this.prepareDelivery(delivery.id)
        if (!prepared) return
        const { subscription, content } = prepared
        delivery = prepared.delivery
        // QQ may wait before submitting or retry without a URL. Re-enter this same
        // lock at the actual submission, refreshing the delivery, language and signal.
        const submitCurrent: SubmitDelivery = submit => this.mutations.run(async () => {
          const current = await this.prepareDelivery(delivery.id)
          if (!current) return
          const completion = submit(current.subscription, current.content)
          void completion.catch(() => undefined)
          return { completion }
        })
        this.lastSentAt = this.clock.now()
        // Submit inside the lock, but wait outside it so a slow adapter cannot block cancellation.
        // Attach the rejection handler immediately, including for synchronous adapter errors.
        const completion = (async () => {
          try {
            if (await this.send(subscription, content, submitCurrent) === false) return
            await this.mutations.run(async () => {
              if (!this.options.signal.aborted) await this.store.updateDelivery(delivery.id, { sentAt: this.clock.now() })
            })
          } catch (error) {
            if (this.options.signal.aborted) return
            await this.mutations.run(async () => {
              if (!this.options.signal.aborted) await this.store.updateDelivery(delivery.id, {
                attempts: delivery.attempts + 1,
                retryAt: this.clock.now() + Math.min(30_000 * 2 ** delivery.attempts, 3_600_000),
              })
            })
            this.options.report(`向订阅会话 ${subscription.id.slice(0, 12)} 推送失败，将重试`, error)
          }
        })().catch(error => {
          if (!this.options.signal.aborted) this.options.report('投递结果保存失败，将在后续检查中恢复', error)
        }).finally(() => { this.inFlight.delete(subscription.id) })
        this.inFlight.set(subscription.id, completion)
        return { completion }
      })
      if (!attempt) continue
      await this.waitForDelivery(attempt.completion)
    }
  }

  // Call only while holding mutations: validation and submission must precede a
  // successful cancellation together, even when a database read is delayed.
  private async prepareDelivery(id: string) {
    const delivery = await this.store.delivery(id)
    if (!delivery || delivery.sentAt || delivery.retryAt > this.clock.now()) return
    const subscription = await this.store.subscription(delivery.subscriptionId)
    if (!subscription || subscription.generation !== delivery.generation) {
      await this.store.deleteDelivery(id)
      return
    }
    this.options.signal.throwIfAborted()
    const locale = this.localeFor(subscription)
    let content = delivery.payload ? formatNotification(delivery.payload, locale, subscription.platform) : delivery.content
    let expiresAt = delivery.expiresAt
    if (delivery.kind === 'scheduled' || delivery.eventKey.startsWith('scheduled:')) {
      const current = this.activeScheduled
      if ((this.api.retryAt ?? 0) > this.clock.now()) {
        this.invalidateAnnouncements()
        return
      }
      if (current === undefined) return
      if (!current || delivery.eventKey !== current.key) {
        await this.store.deleteDelivery(id)
        return
      }
      content = formatScheduled(current.value, locale, subscription.platform)
      // A scheduled time passing never implies execution or expiry.
      expiresAt = 0
    }
    if (expiresAt > 0 && expiresAt <= this.clock.now()) {
      await this.store.deleteDelivery(id)
      return
    }
    return { delivery, subscription, content }
  }

  private waitForDelivery(completion: Promise<void>): Promise<void> {
    const { signal } = this.options
    return new Promise(resolve => {
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        resolve()
      }
      // Stop waiting after 30 seconds, but keep the adapter call tracked until its actual outcome.
      const timer = setTimeout(finish, 30_000)
      signal.addEventListener('abort', finish, { once: true })
      void completion.then(finish)
      if (signal.aborted) finish()
    })
  }
}
