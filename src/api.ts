import type { Api, ApiStateStore, Clock, Reset, ResetListResponse, Source, StatusResponse, Watch } from './types'
import { Serial, clock as systemClock, errorText } from './util'

export interface HttpResponse {
  status: number
  headers: Headers
  body: unknown
}

export type Transport = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<HttpResponse>

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function date(value: unknown): value is string {
  if (typeof value !== 'string') return false
  // Require an explicit RFC 3339 offset before Date.parse can consult the host timezone.
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value)
  if (!match || match[0] !== value) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6])
  const offsetHour = Number(match[7] ?? 0), offsetMinute = Number(match[8] ?? 0)
  // JavaScript Date cannot represent leap seconds; do not silently normalize invalid dates.
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return day >= 1 && day <= daysInMonth && Number.isFinite(Date.parse(value))
}

export { date as isTimestamp }

function source(value: unknown): value is Source {
  return object(value) && typeof value.type === 'string' && ['x_post', 'observed'].includes(value.type)
    && (value.url === undefined || typeof value.url === 'string')
    && (value.author === undefined || typeof value.author === 'string')
}

function reset(value: unknown): value is Reset {
  return object(value) && typeof value.id === 'string' && value.id.length > 0
    && typeof value.reset_type === 'string' && ['regular', 'banked'].includes(value.reset_type)
    && date(value.announced_at) && typeof value.text === 'string' && source(value.source)
}

function watch(value: unknown): value is Watch {
  return object(value) && typeof value.level === 'string' && ['elevated', 'strong'].includes(value.level)
    && (value.reset_chance_percent === null || (typeof value.reset_chance_percent === 'number'
      && Number.isInteger(value.reset_chance_percent) && value.reset_chance_percent >= 0 && value.reset_chance_percent <= 100))
    && typeof value.forecast_window === 'string' && date(value.observed_at) && date(value.expires_at)
    && typeof value.text === 'string' && source(value.source)
}

export function parseStatus(value: unknown): StatusResponse {
  if (!object(value) || !object(value.data) || !object(value.meta)) throw new Error('API 状态响应格式不正确')
  const data = value.data
  const scheduled = data.scheduled_reset
  if ((data.latest_reset !== null && !reset(data.latest_reset))
    || (scheduled !== null && (!reset(scheduled) || !object(scheduled) || scheduled.status !== 'scheduled'
      || (scheduled.scheduled_for !== null && !date(scheduled.scheduled_for))))
    || (data.active_watch !== null && !watch(data.active_watch))
    || !object(data.stats) || typeof data.stats.total !== 'number'
    || (data.stats.last_reset_at !== null && !date(data.stats.last_reset_at))
    || value.meta.api_version !== 'v1' || !date(value.meta.generated_at)) {
    throw new Error('API 状态字段不符合 v1 规范')
  }
  return value as unknown as StatusResponse
}

export function parseHistory(value: unknown): ResetListResponse {
  if (!object(value) || !Array.isArray(value.data) || !value.data.every(reset)
    || !object(value.pagination) || typeof value.pagination.has_more !== 'boolean'
    || (value.pagination.next_cursor !== null && typeof value.pagination.next_cursor !== 'string')
    || (value.pagination.has_more && !value.pagination.next_cursor)) {
    throw new Error('API 历史响应格式不正确')
  }
  return value as unknown as ResetListResponse
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt: number) {
    super(message)
    this.name = 'ApiError'
  }
}

export class CodexApi implements Api {
  private readonly serial = new Serial()
  private lastRequestAt = -Infinity
  private failures = 0
  private blockedUntil = 0
  private etag = ''
  private cachedStatus?: StatusResponse
  private cachedAt = -Infinity
  private cachedRequestedAt = -Infinity
  private stateLoaded = false
  private dirtyState = false
  private recentTask?: Promise<ResetListResponse>
  private recentCache?: { value: ResetListResponse; at: number; statusKey: string }

  constructor(
    private readonly transport: Transport,
    private readonly options: { cacheMs: number; signal: AbortSignal; clock?: Clock; stateStore?: ApiStateStore },
  ) {}

  get retryAt(): number { return this.blockedUntil }

  private get clock(): Clock { return this.options.clock ?? systemClock }

  private async restoreState(): Promise<void> {
    if (this.stateLoaded) return
    const state = await this.options.stateStore?.apiState()
    if (state) {
      if (!Number.isFinite(state.lastRequestAt) || state.lastRequestAt < 0
        || !Number.isFinite(state.blockedUntil) || state.blockedUntil < 0
        || !Number.isInteger(state.failures) || state.failures < 0
        || (state.requestPending !== undefined && typeof state.requestPending !== 'boolean')) {
        throw new Error('数据库中的 API 请求状态无效，已暂停请求')
      }
      if (state.requestPending) {
        // The missing response could have specified an arbitrarily long Retry-After.
        throw new Error('数据库中存在未完成的 API 请求，已暂停网站请求；请按文档“API 请求状态恢复”检查并恢复。')
      }
      // An interrupted request may have started after its preflight write. Allow a quiet period on reload.
      this.lastRequestAt = Math.max(state.lastRequestAt, this.clock.now())
      this.blockedUntil = state.blockedUntil
      this.failures = state.failures
    }
    this.stateLoaded = true
  }

  private async saveState(requestPending = false): Promise<void> {
    this.dirtyState = true
    try {
      await this.options.stateStore?.saveApiState({
        lastRequestAt: this.lastRequestAt, blockedUntil: this.blockedUntil, failures: this.failures, requestPending,
      })
      this.dirtyState = false
    } catch (error) {
      const deadline = this.blockedUntil > this.clock.now() ? `；退避截止时间戳（毫秒）：${this.blockedUntil}` : ''
      throw new Error(`API 请求状态保存失败${deadline}：${errorText(error)}`, { cause: error })
    }
  }

  flushState(): Promise<void> {
    return this.serial.run(async () => {
      this.options.signal.throwIfAborted()
      // Only the process that knows the outcome may complete an unfinished request automatically.
      if (this.dirtyState) await this.saveState()
    })
  }

  private async recordFailure(): Promise<void> {
    if (this.options.signal.aborted) return
    this.failures++
    this.blockedUntil = this.clock.now() + Math.min(60_000 * 2 ** (this.failures - 1), 3_600_000)
    await this.saveState()
  }

  private async recordSuccess(): Promise<void> {
    this.failures = 0
    this.blockedUntil = 0
    await this.saveState()
  }

  private canUseStatusCache(minRequestedAt: number): boolean {
    return Boolean(this.cachedStatus) && this.cachedRequestedAt >= minRequestedAt
      && this.clock.now() - this.cachedAt < this.options.cacheMs
  }

  private async request<T>(path: string, parse: (value: unknown) => T, conditional = false, minRequestedAt = 0): Promise<T> {
    return this.serial.run(async () => {
      this.options.signal.throwIfAborted()
      await this.restoreState()
      if (this.dirtyState) await this.saveState()
      if (conditional && this.canUseStatusCache(minRequestedAt)) {
        return this.cachedStatus as unknown as T
      }
      if (this.clock.now() < this.blockedUntil) {
        throw new ApiError('API 请求已暂停，等待退避时间结束', 429, this.blockedUntil)
      }
      const spacing = 5000 - (this.clock.now() - this.lastRequestAt)
      if (spacing > 0) await this.clock.sleep(spacing, this.options.signal)
      this.options.signal.throwIfAborted()
      this.lastRequestAt = this.clock.now()
      // A crash or failed response write leaves this durable marker for conservative recovery.
      await this.saveState(true)
      if (this.options.signal.aborted) {
        // No HTTP request was submitted, so clearing this marker is safe.
        await this.saveState()
        this.options.signal.throwIfAborted()
      }
      const headers: Record<string, string> = { Accept: 'application/json', 'Cache-Control': 'no-cache' }
      if (conditional && this.etag) headers['If-None-Match'] = this.etag
      let response: HttpResponse
      try {
        // Database latency must not consume the interval between actual HTTP starts.
        this.lastRequestAt = this.clock.now()
        response = await this.transport(`https://codex-resets.com${path}`, headers, this.options.signal)
      } catch (error) {
        await this.recordFailure()
        throw error
      }
      this.options.signal.throwIfAborted()
      if (response.status === 304 && conditional && this.cachedStatus) {
        this.cachedAt = this.clock.now()
        this.cachedRequestedAt = this.lastRequestAt
        await this.recordSuccess()
        return this.cachedStatus as unknown as T
      }
      if (response.status !== 200) {
        const problem = object(response.body) ? response.body : {}
        const description = typeof problem.detail === 'string' ? problem.detail : `HTTP ${response.status}`
        this.failures++
        const retry = response.headers.get('retry-after')
        const retryDelay = retry && /^\d+$/.test(retry.trim())
          ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.clock.now() : 0
        const delay = Math.max(5000, Number.isFinite(retryDelay) ? retryDelay : 0,
          Math.min(60_000 * 2 ** (this.failures - 1), 3_600_000))
        this.blockedUntil = this.clock.now() + delay
        await this.saveState()
        throw new ApiError(`Codex Resets API：${description}`, response.status, this.blockedUntil)
      }
      let parsed: T
      try {
        const body = typeof response.body === 'string' ? JSON.parse(response.body) : response.body
        parsed = parse(body)
      } catch (error) {
        await this.recordFailure()
        throw error
      }
      if (conditional) {
        this.etag = response.headers.get('etag') ?? ''
        this.cachedStatus = parsed as unknown as StatusResponse
        this.cachedAt = this.clock.now()
        this.cachedRequestedAt = this.lastRequestAt
      }
      await this.recordSuccess()
      return parsed
    })
  }

  async status(minRequestedAt = 0): Promise<StatusResponse> {
    this.options.signal.throwIfAborted()
    if (!this.dirtyState && this.canUseStatusCache(minRequestedAt)) return this.cachedStatus!
    return this.request('/api/v1/status', parseStatus, true, minRequestedAt)
  }

  async history(from: string, cursor?: string, limit = 100): Promise<ResetListResponse> {
    const query = new URLSearchParams({ from, limit: String(limit), order: 'asc' })
    if (cursor) query.set('cursor', cursor)
    return this.request(`/api/v1/resets?${query}`, parseHistory)
  }

  async recent(): Promise<ResetListResponse> {
    this.options.signal.throwIfAborted()
    const latest = this.cachedStatus?.data.latest_reset
    const statusKey = JSON.stringify(latest ? [latest.reset_type, latest.id, latest.announced_at] : null)
    const cached = this.recentCache
    if (!this.dirtyState && cached && cached.statusKey === statusKey && this.clock.now() - cached.at < this.options.cacheMs) {
      return Promise.resolve(cached.value)
    }
    // Coalesce interactive reads without changing the ascending catch-up cursor or checkpoint.
    if (!this.recentTask) this.recentTask = this.request('/api/v1/resets?limit=3&order=desc', parseHistory)
      .then(value => {
        this.recentCache = { value, at: this.clock.now(), statusKey }
        return value
      }).finally(() => { this.recentTask = undefined })
    return this.recentTask
  }
}
