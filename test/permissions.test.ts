import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'koishi'
import { managementAccess, validateQQGroupManagers, type QQGroupManager } from '../src/permissions'

function session(platform: string, internal: Record<string, unknown> = {}, roles?: { id: string; name?: string }[]): Session {
  return { platform, guildId: '100', userId: '200', isDirect: false,
    event: { member: roles ? { user: { id: '200' }, roles } : undefined },
    bot: { internal, getGuildMember: vi.fn(async () => ({ user: { id: '200' }, roles: [] })) },
  } as unknown as Session
}

describe('platform administrator authorization', () => {
  it('times out unavailable role queries without authorizing a late response', async () => {
    vi.useFakeTimers()
    try {
      let release!: (value: unknown) => void
      const pending = new Promise(resolve => { release = resolve })
      const result = managementAccess(session('telegram', { getChatMember: () => pending }))
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await result).toBe('unavailable')
      release({ user: { id: 200 }, status: 'administrator' })
      expect(await result).toBe('unavailable')
    } finally { vi.useRealTimers() }
  })

  it.each(['onebot', 'qq', 'qqguild', 'telegram', 'discord', 'unsupported'])('allows private messages on %s without querying roles', async platform => {
    const value = session(platform)
    Object.assign(value, { isDirect: true })
    expect(await managementAccess(value)).toBe('allowed')
    expect(value.bot.getGuildMember).not.toHaveBeenCalled()
  })

  it.each(['owner', 'admin', 'member'])('checks OneBot sender role %s', async role => {
    const value = session('onebot', {}, [{ id: role }])
    expect(await managementAccess(value)).toBe(role === 'member' ? 'denied' : 'allowed')
    expect(value.bot.getGuildMember).not.toHaveBeenCalled()
  })

  it('queries missing OneBot roles and rejects mismatched identities and role labels', async () => {
    const value = session('onebot')
    vi.mocked(value.bot.getGuildMember).mockResolvedValue({ user: { id: '200' }, roles: [{ id: 'admin' }] })
    expect(await managementAccess(value)).toBe('allowed')
    expect(value.bot.getGuildMember).toHaveBeenCalledWith('100', '200')
    vi.mocked(value.bot.getGuildMember).mockResolvedValue({ user: { id: 'other' }, roles: [{ id: 'admin' }] })
    expect(await managementAccess(value)).toBe('unavailable')
    expect(await managementAccess(session('onebot', {}, [{ id: 'custom', name: 'admin' }]))).toBe('unavailable')
  })

  it.each(['creator', 'administrator', 'member', 'restricted', 'left', 'kicked'])('checks Telegram status %s through its internal API', async status => {
    const getChatMember = vi.fn(async () => ({ user: { id: 200 }, status }))
    expect(await managementAccess(session('telegram', { getChatMember }))).toBe(['creator', 'administrator'].includes(status) ? 'allowed' : 'denied')
    expect(getChatMember).toHaveBeenCalledWith({ chat_id: '100', user_id: 200 })
  })

  it('does not trust missing, stale event-only, anonymous or mismatched Telegram roles', async () => {
    expect(await managementAccess(session('telegram', {}, [{ id: 'administrator' }]))).toBe('unavailable')
    expect(await managementAccess(session('telegram', { getChatMember: async () => ({ user: { id: 201 }, status: 'administrator' }) }))).toBe('unavailable')
    expect(await managementAccess(session('telegram', { getChatMember: async () => ({ user: { id: 200 }, status: 'unknown' }) }))).toBe('unavailable')
    const value = session('telegram', { getChatMember: vi.fn() })
    Object.assign(value, { userId: 'anonymous' })
    expect(await managementAccess(value)).toBe('unavailable')
    expect(value.bot.internal.getChatMember).not.toHaveBeenCalled()
  })

  it('accepts Discord ownership without inferring it from a role name', async () => {
    const getGuild = vi.fn(async () => ({ id: '100', owner_id: '200' }))
    expect(await managementAccess(session('discord', { getGuild }))).toBe('allowed')
    expect(getGuild).toHaveBeenCalledWith('100')
  })

  it.each(['8', '1099511627784', 8n, 8, '32', '0'])('checks Discord permission bits %s', async permissions => {
    const internal = {
      getGuild: vi.fn(async () => ({ id: '100', owner_id: 'owner' })),
      getGuildMember: vi.fn(async () => ({ user: { id: '200' }, roles: ['role-1'] })),
      getGuildRoles: vi.fn(async () => [{ id: '100', permissions: '0' }, { id: 'role-1', name: 'admin', permissions }]),
    }
    expect(await managementAccess(session('discord', internal))).toBe(BigInt(permissions) & 8n ? 'allowed' : 'denied')
    expect(internal.getGuildMember).toHaveBeenCalledWith('100', '200')
    expect(internal.getGuildRoles).toHaveBeenCalledWith('100')
  })

  it('rejects missing Discord roles, unsafe numeric permissions and mismatched server/member identities', async () => {
    const internal = {
      getGuild: vi.fn(async () => ({ id: '100', owner_id: 'owner' })),
      getGuildMember: vi.fn(async () => ({ user: { id: '200' }, roles: ['role-1'] })),
      getGuildRoles: vi.fn(async () => [{ id: '100', permissions: '0' }]),
    }
    expect(await managementAccess(session('discord', internal))).toBe('unavailable')
    internal.getGuildRoles.mockResolvedValue([{ id: '100', permissions: '0' }, { id: 'role-1', permissions: Number.MAX_SAFE_INTEGER + 1 } as never])
    expect(await managementAccess(session('discord', internal))).toBe('unavailable')
    internal.getGuild.mockResolvedValue({ id: 'wrong-server', owner_id: '200' })
    expect(await managementAccess(session('discord', internal))).toBe('unavailable')
    internal.getGuild.mockResolvedValue({ id: '100', owner_id: 'owner' })
    internal.getGuildMember.mockResolvedValue({ user: { id: 'other' }, roles: ['role-1'] })
    expect(await managementAccess(session('discord', internal))).toBe('unavailable')
  })

  it.each(['onebot', 'telegram', 'discord', 'unsupported'])('fails closed on unavailable %s role information', async platform => {
    const fail = vi.fn(async () => { throw new Error('adapter offline') })
    const value = session(platform, { getChatMember: fail, getGuild: fail })
    value.bot.getGuildMember = fail
    expect(await managementAccess(value)).toBe(platform === 'unsupported' ? 'unsupported' : 'unavailable')
    expect(await managementAccess(session('unsupported', {}, [{ id: 'admin' }]))).toBe('unsupported')
  })
})

describe('official QQ explicit group authorization', () => {
  const grants: QQGroupManager[] = [{ selfId: 'bot-a', groupId: '100', userIds: ['200'] }]
  const qqSession = () => Object.assign(session('qq'), { selfId: 'bot-a', channelId: '100' })

  it('requires opt-in and exact bot, group and member identities without calling member APIs', async () => {
    const value = qqSession()
    expect(await managementAccess(value)).toBe('qqNotConfigured')
    expect(await managementAccess(value, grants)).toBe('allowed')
    expect(value.bot.getGuildMember).not.toHaveBeenCalled()
    expect(await managementAccess(Object.assign(qqSession(), { selfId: 'bot-b' }), grants)).toBe('qqNotConfigured')
    expect(await managementAccess(Object.assign(qqSession(), { guildId: 'other', channelId: 'other' }), grants)).toBe('qqNotConfigured')
    expect(await managementAccess(Object.assign(qqSession(), { userId: 'other' }), grants)).toBe('qqNotAuthorized')
    expect(await managementAccess(Object.assign(qqSession(), { userId: '200-extra' }), grants)).toBe('qqNotAuthorized')
  })

  it.each([
    { selfId: '' }, { userId: '' }, { guildId: '' }, { channelId: '' },
    { channelId: 'other' }, { selfId: '*' }, { userId: ' 200' },
  ])('rejects missing or inconsistent QQ destination identities: %j', patch => {
    return expect(managementAccess(Object.assign(qqSession(), patch), grants)).resolves.toBe('unavailable')
  })

  it('does not treat role labels or high Koishi authority as QQ grants or authorize other platforms', async () => {
    const value = qqSession()
    value.event.member = { user: { id: '200' }, roles: [{ id: 'admin', name: 'owner' }] }
    Object.assign(value, { user: { authority: 5 } })
    expect(await managementAccess(value)).toBe('qqNotConfigured')
    for (const platform of ['qqguild', 'sandbox:test', 'unsupported']) {
      expect(await managementAccess(Object.assign(qqSession(), { platform }), grants)).toBe('unsupported')
    }
    expect(await managementAccess(Object.assign(session('onebot', {}, [{ id: 'member' }]), { selfId: 'bot-a', channelId: '100' }), grants)).toBe('denied')
  })

  it('supports multiple explicit members and entries and observes revoked grants immediately', async () => {
    const value = qqSession()
    const entries = [{ selfId: 'bot-a', groupId: '100', userIds: ['other'] }, ...structuredClone(grants)]
    expect(await managementAccess(value, entries)).toBe('allowed')
    entries.pop()
    expect(await managementAccess(value, entries)).toBe('qqNotAuthorized')
    expect(await managementAccess(value, [])).toBe('qqNotConfigured')
  })

  it.each([
    null, {}, [null], [{}], [{ ...grants[0], selfId: '*' }], [{ ...grants[0], groupId: ' ' }],
    [{ ...grants[0], userIds: [] }], [{ ...grants[0], userIds: ['*'] }],
    [{ ...grants[0], userIds: [200] }], [{ ...grants[0], userIds: '200' }],
    [{ ...grants[0], selfId: 123 }], [{ ...grants[0], userIds: ['200', ''] }],
    [{ ...grants[0], userIds: ['200\n'] }], [{ ...grants[0], groupId: '100\r\n' }],
  ])('rejects invalid authorization configuration: %j', value => {
    expect(() => validateQQGroupManagers(value)).toThrow('Invalid qqGroupManagers')
  })

  it('accepts empty defaults and complete explicit grants', () => {
    expect(() => validateQQGroupManagers([])).not.toThrow()
    expect(() => validateQQGroupManagers(grants)).not.toThrow()
  })
})
