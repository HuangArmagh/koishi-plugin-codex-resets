import type { Context } from 'koishi'
import { isReset } from './api'
import { executionLink, isExecutionDelivery, resetKey } from './execution'
import type { ApiRequestState, Checkpoint, Delivery, ExecutionLink, Store, Subscription } from './types'
import { hash, targetKey } from './util'

interface StateRow {
  id: string
  snapshot: Checkpoint
}

declare module 'koishi' {
  interface Tables {
    codex_reset_subscription: Subscription
    codex_reset_delivery: Delivery
    codex_reset_state: StateRow
    codex_reset_api_state: ApiRequestState & { id: string }
    codex_reset_execution: { id: string; eventKey: string; originalKey: string }
  }
}

export function defineModels(ctx: Context): void {
  ctx.model.extend('codex_reset_subscription', {
    id: 'string', platform: 'string', selfId: 'string', type: 'string', targetId: 'string', guildId: 'string',
    generation: 'string', subscribedAt: 'double', baselined: 'boolean', baselineResetKey: 'string',
    baselineExecutionKeys: { type: 'json', initial: null },
    pendingResets: { type: 'json', initial: [] },
    locale: { type: 'string', initial: '' },
  }, { primary: 'id' })
  ctx.model.extend('codex_reset_delivery', {
    id: 'string', subscriptionId: 'string', generation: 'string', eventKey: 'string', kind: 'string',
    content: 'text', createdAt: 'double', expiresAt: 'double', retryAt: 'double', attempts: 'unsigned', sentAt: 'double',
    payload: { type: 'json', initial: null },
  }, { primary: 'id' })
  ctx.model.extend('codex_reset_state', {
    id: 'string', snapshot: 'json',
  }, { primary: 'id' })
  ctx.model.extend('codex_reset_api_state', {
    id: 'string', lastRequestAt: 'double', blockedUntil: 'double', failures: 'unsigned',
    requestPending: { type: 'boolean', initial: false },
  }, { primary: 'id' })
  ctx.model.extend('codex_reset_execution', {
    id: 'string', eventKey: 'string', originalKey: { type: 'string', initial: '' },
  }, { primary: 'id' })
}

export class KoishiStore implements Store {
  private migration?: Promise<void>

  constructor(private readonly ctx: Context) {}

  private prepare(): Promise<void> {
    // Gate every subscription/delivery operation until migration succeeds, including retries after a failure.
    return this.migration ??= this.migrateTopics().then(() => this.discardWatches()).then(() => this.restoreExecutions())
      .then(() => this.restoreExecutionBaselines()).catch(error => {
        this.migration = undefined
        throw error
      })
  }

  private async restoreExecutions(): Promise<void> {
    // Retain evidence from pre-upgrade records, even if their notification has not been sent yet.
    const database = this.ctx.database
    const deliveries = await database.get('codex_reset_delivery', { kind: 'reset' })
    const subscriptions = await database.get('codex_reset_subscription', {})
    const checkpoint = await this.checkpoint()
    const keys = [
      ...deliveries.filter(isExecutionDelivery).map(row => row.eventKey),
      ...subscriptions.map(row => row.baselineResetKey), checkpoint?.latestResetKey ?? '',
    ].filter(key => /^reset:(regular|banked):./.test(key))
    const links = deliveries.filter(isExecutionDelivery).flatMap(row => {
      const reset = row.payload?.reset
      // Do not turn malformed or mismatched legacy payloads into execution aliases.
      const link = isReset(reset) && resetKey(reset) === row.eventKey ? executionLink(reset) : undefined
      return link ? [link] : []
    })
    await this.writeExecutions(keys, links)
  }

  private async writeExecutions(eventKeys: string[], links: ExecutionLink[] = []): Promise<void> {
    const originals = new Map(links.map(link => [link.observedKey, link.originalKey]))
    const keys = [...eventKeys, ...links.flatMap(link => [link.observedKey, link.originalKey])]
    const values = [...new Set(keys)].map(eventKey => ({ id: hash([eventKey]), eventKey,
      // Omit this field on ordinary writes so an existing link survives later snapshots.
      ...(originals.has(eventKey) ? { originalKey: originals.get(eventKey)! } : {}),
    }))
    if (values.length) await this.ctx.database.upsert('codex_reset_execution', values)
  }

  private async restoreExecutionBaselines(): Promise<void> {
    const database = this.ctx.database
    const subscriptions = await database.get('codex_reset_subscription', {})
    if (!subscriptions.some(row => row.baselineExecutionKeys == null)) return
    const deliveries = (await database.get('codex_reset_delivery', { kind: 'reset' }))
      .filter(row => (!row.payload || row.payload.type === 'reset') && /^reset:(regular|banked):./.test(row.eventKey))
    const checkpoint = await this.checkpoint()
    for (const subscription of subscriptions) {
      if (subscription.baselineExecutionKeys != null) continue
      // Legacy execution keys have no observation timestamp. Only reconstruct
      // exclusions supported by records that predate registration, never all keys.
      const keys = deliveries.filter(row => row.createdAt > 0 && row.createdAt < subscription.subscribedAt).map(row => row.eventKey)
      if (checkpoint?.latestResetKey && checkpoint.checkedAt > 0 && checkpoint.checkedAt < subscription.subscribedAt) {
        keys.push(checkpoint.latestResetKey)
      }
      if (subscription.baselineResetKey) keys.push(subscription.baselineResetKey)
      await database.set('codex_reset_subscription', { id: subscription.id }, { baselineExecutionKeys: [...new Set(keys)] })
    }
  }

  async executionKeys(): Promise<string[]> {
    await this.prepare()
    return (await this.ctx.database.get('codex_reset_execution', {})).map(row => row.eventKey)
  }

  async hasExecution(eventKey: string): Promise<boolean> {
    await this.prepare()
    return Boolean((await this.ctx.database.get('codex_reset_execution', { id: hash([eventKey]) })).length)
  }

  async executionLinks(): Promise<ExecutionLink[]> {
    await this.prepare()
    return (await this.ctx.database.get('codex_reset_execution', { originalKey: { $ne: '' } }))
      .map(row => ({ observedKey: row.eventKey, originalKey: row.originalKey }))
  }

  async saveExecutions(eventKeys: string[], links: ExecutionLink[] = []): Promise<void> {
    await this.prepare()
    await this.writeExecutions(eventKeys, links)
  }

  private async discardWatches(): Promise<void> {
    const database = this.ctx.database
    for (const old of await database.get('codex_reset_delivery', {})) {
      if (old.kind === 'watch' || old.eventKey.startsWith('watch:') || old.payload?.type === 'watch') {
        await database.remove('codex_reset_delivery', { id: old.id })
      }
    }
  }

  private async migrateTopics(): Promise<void> {
    const database = this.ctx.database
    for (const old of await database.get('codex_reset_subscription', {})) {
      const id = targetKey(old)
      if (id === old.id || old.id !== hash([old.platform, old.selfId, old.type, old.targetId])) continue
      const current = (await database.get('codex_reset_subscription', { id }))[0]
      if (current && current.generation !== old.generation) {
        throw new Error('Telegram 话题订阅迁移存在冲突，已暂停订阅和投递操作；请检查数据库')
      }
      if (!current) await database.create('codex_reset_subscription', { ...old, id })
      // Copy before deleting. Interrupted migrations resume without resetting sent/retry state.
      for (const delivery of await database.get('codex_reset_delivery', { subscriptionId: old.id })) {
        const deliveryId = hash([id, delivery.generation, delivery.eventKey])
        if (!(await database.get('codex_reset_delivery', { id: deliveryId })).length) {
          await database.create('codex_reset_delivery', { ...delivery, id: deliveryId, subscriptionId: id })
        }
        await database.remove('codex_reset_delivery', { id: delivery.id })
      }
      await database.remove('codex_reset_subscription', { id: old.id })
    }
  }

  async subscriptions(): Promise<Subscription[]> {
    await this.prepare()
    return this.ctx.database.get('codex_reset_subscription', {})
  }

  async subscription(id: string): Promise<Subscription | undefined> {
    await this.prepare()
    return (await this.ctx.database.get('codex_reset_subscription', { id }))[0]
  }

  async saveSubscription(value: Subscription): Promise<void> {
    await this.prepare()
    await this.ctx.database.upsert('codex_reset_subscription', [value])
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.prepare()
    await this.ctx.database.remove('codex_reset_subscription', { id })
    await this.ctx.database.remove('codex_reset_delivery', { subscriptionId: id })
  }

  async checkpoint(): Promise<Checkpoint | null> {
    return (await this.ctx.database.get('codex_reset_state', { id: 'global' }))[0]?.snapshot ?? null
  }

  async saveCheckpoint(snapshot: Checkpoint): Promise<void> {
    await this.ctx.database.upsert('codex_reset_state', [{ id: 'global', snapshot }])
  }

  async enqueue(value: Delivery): Promise<void> {
    await this.prepare()
    const existing = (await this.ctx.database.get('codex_reset_delivery', { id: value.id }))[0]
    if (existing) {
      if (!existing.sentAt && existing.kind === 'scheduled' && value.eventKey.startsWith('scheduled:')
        && (existing.expiresAt !== value.expiresAt || existing.content !== value.content
          || JSON.stringify(existing.payload) !== JSON.stringify(value.payload))) {
        await this.ctx.database.set('codex_reset_delivery', { id: value.id, sentAt: 0 }, {
          content: value.content, expiresAt: value.expiresAt, payload: value.payload ?? null,
        })
      }
      return
    }
    await this.ctx.database.create('codex_reset_delivery', value)
  }

  async pending(now: number): Promise<Delivery[]> {
    await this.prepare()
    return this.ctx.database.get('codex_reset_delivery', { sentAt: 0, retryAt: { $lte: now } }, { sort: { createdAt: 'asc' } })
  }

  async updateDelivery(id: string, changes: Partial<Delivery>): Promise<void> {
    await this.prepare()
    await this.ctx.database.set('codex_reset_delivery', { id }, changes)
  }

  async delivery(id: string): Promise<Delivery | undefined> {
    await this.prepare()
    return (await this.ctx.database.get('codex_reset_delivery', { id }))[0]
  }

  async executionDeliveries(subscriptionId: string, generation: string, eventKeys: string[]): Promise<Delivery[]> {
    await this.prepare()
    return (await this.ctx.database.get('codex_reset_delivery', {
      subscriptionId, generation, kind: 'reset', eventKey: { $in: eventKeys },
    })).filter(isExecutionDelivery)
  }

  async deleteDelivery(id: string): Promise<void> {
    await this.prepare()
    await this.ctx.database.remove('codex_reset_delivery', { id })
  }

  async cancelScheduledExcept(activeKey: string | null): Promise<void> {
    await this.prepare()
    const pending = await this.ctx.database.get('codex_reset_delivery', { kind: 'scheduled', sentAt: 0 })
    const ids = pending.filter(delivery => delivery.eventKey !== activeKey).map(delivery => delivery.id)
    if (ids.length) await this.ctx.database.remove('codex_reset_delivery', { id: { $in: ids } })
  }

  async apiState(): Promise<ApiRequestState | null> {
    const row = (await this.ctx.database.get('codex_reset_api_state', { id: 'global' }))[0]
    if (!row) return null
    return { lastRequestAt: row.lastRequestAt, blockedUntil: row.blockedUntil, failures: row.failures, requestPending: row.requestPending }
  }

  async saveApiState(value: ApiRequestState): Promise<void> {
    await this.ctx.database.upsert('codex_reset_api_state', [{ id: 'global', ...value }])
  }
}
