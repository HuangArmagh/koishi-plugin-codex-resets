import type { Session } from 'koishi'

export type ManagementAccess = 'allowed' | 'denied' | 'unavailable' | 'unsupported' | 'qqNotConfigured' | 'qqNotAuthorized'

/** Fallback operator grants when official QQ member roles are unavailable. */
export interface QQGroupManager {
  selfId: string
  groupId: string
  userIds: string[]
}

export const qqIdentityPattern = /^[^\s*]+(?![\s\S])/
const validQQIdentity = (value: unknown): value is string => typeof value === 'string' && qqIdentityPattern.test(value)

function validQQGroupManager(value: unknown): value is QQGroupManager {
  if (!value || typeof value !== 'object') return false
  const row = value as Partial<QQGroupManager>
  return validQQIdentity(row.selfId) && validQQIdentity(row.groupId)
    && Array.isArray(row.userIds) && row.userIds.length > 0 && row.userIds.every(validQQIdentity)
}

export function validateQQGroupManagers(value: unknown): asserts value is QQGroupManager[] {
  if (!Array.isArray(value) || !value.every(validQQGroupManager)) {
    throw new Error('Invalid qqGroupManagers: each entry requires exact selfId, groupId and non-empty userIds; whitespace and wildcards are not allowed')
  }
}

function roleAccess(value: unknown, allowed: string[], ordinary: string[]): ManagementAccess {
  if (typeof value !== 'string') return 'unavailable'
  if (allowed.includes(value)) return 'allowed'
  return ordinary.includes(value) ? 'denied' : 'unavailable'
}

function permissionBits(value: unknown): bigint | undefined {
  if (typeof value === 'bigint' && value >= 0n) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value)
}

/** Platform roles or explicit QQ grants authorize access; Koishi authority and display names do not. */
export async function managementAccess(session: Session, qqGroupManagers: readonly QQGroupManager[] = []): Promise<ManagementAccess> {
  if (session.isDirect) return 'allowed'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      checkGroupAccess(session, qqGroupManagers),
      new Promise<ManagementAccess>(resolve => { timer = setTimeout(() => resolve('unavailable'), 15_000) }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function checkGroupAccess(session: Session, qqGroupManagers: readonly QQGroupManager[]): Promise<ManagementAccess> {
  const { guildId, userId, bot, platform } = session
  if (!guildId || !userId) return 'unavailable'
  try {
    if (platform === 'qq') {
      // Official QQ group events use the same group OpenID for guild and channel.
      // Bind authorization to the actual destination and bot, never to a display name or QQ number.
      if (!validQQIdentity(session.selfId) || !validQQIdentity(guildId) || !validQQIdentity(userId)
        || session.channelId !== guildId) return 'unavailable'
      // Published QQ adapters expose owner/admin/member on message events and getGuildMember.
      // An identity mismatch is never eligible for fallback authorization.
      const fromMember = (member: typeof session.event.member): ManagementAccess => {
        if (member?.user?.id && member.user.id !== userId) return 'unavailable'
        const roles = member?.roles
        if (!Array.isArray(roles) || roles.length !== 1) return 'unavailable'
        return roleAccess(roles[0]?.id, ['owner', 'admin'], ['member'])
      }
      const eventMember = session.event.member
      if (eventMember?.user?.id && eventMember.user.id !== userId) return 'unavailable'
      let access = fromMember(eventMember)
      if (access === 'allowed' || access === 'denied') return access
      try {
        const member = await bot.getGuildMember(guildId, userId)
        if (member?.user && member.user.id !== userId) return 'unavailable'
        access = fromMember(member)
        if (access === 'allowed' || access === 'denied') return member?.user?.id === userId ? access : 'unavailable'
      } catch { /* Older adapters or QQ API permissions may not provide roles. */ }
      const grants = qqGroupManagers.filter(row => validQQGroupManager(row)
        && row.selfId === session.selfId && row.groupId === guildId)
      if (!grants.length) return 'qqNotConfigured'
      return grants.some(row => row.userIds.includes(userId)) ? 'allowed' : 'qqNotAuthorized'
    }
    if (platform === 'onebot') {
      // OneBot maps the protocol's sender.role to the member's role ID.
      const member = session.event.member?.roles?.length ? session.event.member : await bot.getGuildMember(guildId, userId)
      if (member?.user?.id && member.user.id !== userId) return 'unavailable'
      const roles = member?.roles
      if (!roles?.length) return 'unavailable'
      const results = roles.map(role => roleAccess(role.id, ['owner', 'admin'], ['member']))
      return results.includes('allowed') ? 'allowed' : results.every(value => value === 'denied') ? 'denied' : 'unavailable'
    }
    if (platform === 'telegram') {
      // The Telegram adapter's normalized GuildMember omits administrator status.
      if (typeof bot.internal?.getChatMember !== 'function' || !/^\d+$/.test(userId)) return 'unavailable'
      const id = Number(userId)
      if (!Number.isSafeInteger(id)) return 'unavailable'
      const member = await bot.internal.getChatMember({ chat_id: guildId, user_id: id })
      if (String(member?.user?.id) !== userId) return 'unavailable'
      return roleAccess(member.status, ['creator', 'administrator'], ['member', 'restricted', 'left', 'kicked'])
    }
    if (platform === 'discord') {
      const internal = bot.internal
      if (typeof internal?.getGuild !== 'function') return 'unavailable'
      const guild = await internal.getGuild(guildId)
      if (guild?.id !== guildId || typeof guild.owner_id !== 'string') return 'unavailable'
      if (guild.owner_id === userId) return 'allowed'
      if (typeof internal.getGuildMember !== 'function' || typeof internal.getGuildRoles !== 'function') return 'unavailable'
      const member = await internal.getGuildMember(guildId, userId)
      if (member?.user?.id !== userId || !Array.isArray(member.roles) || !member.roles.every((id: unknown) => typeof id === 'string')) return 'unavailable'
      const roles = await internal.getGuildRoles(guildId)
      if (!Array.isArray(roles)) return 'unavailable'
      const ids = new Set<string>([guildId, ...member.roles]) // Include @everyone, whose ID is the guild ID.
      let permissions = 0n
      for (const id of ids) {
        const bits = permissionBits(roles.find(role => role?.id === id)?.permissions)
        if (bits === undefined) return 'unavailable'
        permissions |= bits
      }
      return permissions & 8n ? 'allowed' : 'denied'
    }
    // Other adapters must supply a platform-specific check before group mutations are supported.
    return 'unsupported'
  } catch {
    return 'unavailable'
  }
}
