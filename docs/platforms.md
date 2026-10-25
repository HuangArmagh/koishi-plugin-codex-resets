# 平台接入与订阅权限

插件通过 Koishi 适配器接收指令、主动发送消息。群聊管理权限需要可靠的平台身份信息；下表区分消息收发能力和已经实现的群权限校验。

| 平台 / 适配器 | 群聊或频道订阅、取消 | 状态查询与私聊 |
| --- | --- | --- |
| QQ / 官方 OneBot 适配器，平台标识 `onebot` | 当前群的 `owner`、`admin` | 所有用户 |
| QQ / QQ 官方适配器，平台标识 `qq` | 维护者通过 `qqGroupManagers` 为当前机器人、群登记的用户；不核验平台角色 | 所有用户 |
| Telegram / 官方 Telegram 适配器 | 当前群的 `creator`、`administrator` | 所有用户 |
| Discord / 官方 Discord 适配器 | 服务器所有者、具有 `ADMINISTRATOR` 的成员；仅操作当前频道 | 所有用户 |
| Koishi 官方沙盒，平台标识 `sandbox:` | 未提供平台管理员身份，暂不放行 | 查询、私聊订阅及主动推送可用 |
| 其他平台、QQ 频道 `qqguild`、未提供所需能力的桥接适配器 | 暂不放行群聊订阅和取消 | 适配器能接收指令、支持相应发送接口时可用 |

所有用户均不需要最低 Koishi 用户等级，但仍受实例的全局权限设置和会话过滤约束。Koishi 高权限用户、名字为“管理员”的角色，以及 Discord 的“管理服务器”权限，都不能替代上述平台管理员身份。

无前缀和 `/` 兼容入口也遵守实际别名的启用和过滤设置。在指令管理中禁用、删除或限制某个别名后，该别名的兼容形式同步受限；其他启用的别名仍可使用。过滤按本次会话计算，群主／管理员也不能绕过。仅禁用某个入口不会取消已有订阅；需要停止推送时，使用仍启用的关闭指令。

Discord 等结构化原生交互入口同样检查指令权限和别名过滤。比如禁用 `codexresetsubscribe` 后，原生菜单调用也不能订阅；返回当前配置语言的权限不足提示，关闭 `showWarning` 时静默拒绝。禁用某个指令名不影响其他启用的别名；对状态、开启和关闭三条指令均生效。

原生入口已识别的指令若带有多余参数或未知选项，会返回插件自带的对应语言提示，固定 `locale` 优先。不会因此修改订阅、切换推送语言或发起查询。兼容入口仍要求完整指令，带额外参数的普通消息不触发。

无法获取成员身份、返回数据不完整、接口失败或 15 秒内未完成校验时，回复无法验证权限，不改变订阅或语言。未支持的适配器会明确提示“此适配器暂不支持群聊订阅权限校验”。平台角色校验不做长期缓存，QQ 人工授权以当前生效配置为准。既有群订阅会继续推送；取消仍需有权限的用户通过支持的适配器执行。

## QQ 官方适配器

`@koishijs/plugin-adapter-qq` 的普通 QQ 群使用平台标识 `qq`，不同于 OneBot 的 `onebot` 和 QQ 频道的 `qqguild`。当前官方群接口没有可供本插件核验群主／管理员的成员角色，因此通过维护者手动配置授权。提高 Koishi 用户等级、勾选事件或关闭 QQ 沙箱模式不会替代授权。

在 `codex-resets` 的插件配置中添加 `qqGroupManagers` 项：

```yaml
qqGroupManagers:
  - selfId: "BOT_APP_ID"
    groupId: "GROUP_OPENID"
    userIds:
      - "MEMBER_OPENID"
```

以上均为占位符，必须替换为实际平台标识：`selfId` 是机器人 ID，`groupId` 是该群的 `session.guildId`（与 `session.channelId` 相同），`userIds` 是允许管理该群订阅的成员 `session.userId` 列表。不要填写普通 QQ 号、群号、昵称、Koishi 用户数据库编号或私聊获得的用户 ID。所有字段均精确匹配，不支持通配符和空值。可为不同机器人、群分别添加条目。

获取标识时，在 Koishi 控制台的用户表与频道表查看 `qq` 平台记录：用户表的 `qq` 字段对应用户 OpenID，频道表的 `id` 对应群 OpenID，`assignee` 对应负责该频道的机器人 ID。由拟授权用户先在目标群发送一次 `重置状态` 生成会话记录；结合现场测试确认对应记录，不能仅根据表中顺序或昵称猜测。如果实例已启用官方 `inspect` 插件，也可在该群检查会话标识。只在自己的控制台保存这些值，不要把真实 OpenID、配置密钥提交到仓库或公开包中。

配置生效后，授权用户仍须在目标群发送 `重置订阅开启`，收到一条订阅成功确认后才会注册；发送 `重置订阅关闭` 则取消。配置名单本身不创建订阅、不发送测试消息。未登记该机器人／群时提示需要配置 `qqGroupManagers`；已登记该群但用户不在名单中时提示未授权。其他机器人、其他群、QQ 频道、角色名称以及 Koishi 高等级用户都不会继承这份授权。

**此授权由维护者负责，不会随 QQ 群角色变化自动撤销。**移除或替换授权用户后保存配置，旧用户不能再管理订阅，但已有订阅继续推送；如需停止，应先由有权用户取消订阅，或保留另一位授权用户执行取消。状态查询和私聊不受名单限制，实例的全局权限及指令过滤仍然生效。

授权成功只确认订阅写入，主动发送仍受 QQ 官方消息策略、机器人资质和发送权限限制，应另行在实际群中验证。

依据：[官方 QQ 适配器及平台标识](https://koishi.chat/zh-CN/plugins/adapter/qq#内部接口)、[官方群消息转换](https://github.com/satorijs/satori/blob/main/adapters/qq/src/utils.ts)。

For the official QQ adapter (`qq`), configure `qqGroupManagers` with exact `selfId`, group OpenID (`groupId`) and member OpenIDs (`userIds`) from that group. These are manual operator grants, not verified QQ administrator roles. The default empty list denies group management. Grants do not subscribe automatically, do not apply to `qqguild` or other platforms, and must be updated manually when membership roles change. Removing a grant does not cancel an existing subscription. Public status and private commands remain available, subject to Koishi's existing permissions and filters. Proactive delivery still requires permission from QQ.

## QQ / OneBot

使用已连接的 OneBot 适配器，确认其正常提供群成员的角色 ID。插件优先读取本次消息中可信的 `member.roles`；缺失时调用适配器的 `getGuildMember`。识别协议角色 `owner` 和 `admin`，普通 `member` 不允许管理群订阅。

部分桥接实现未必返回这些身份信息，不能仅因“支持 QQ”就认为群管理员校验可用。无法确认时会拒绝群管理操作。QQ 官方群适配器使用上节的显式授权，不借用 OneBot 角色。私聊仍取决于该适配器是否支持私聊和主动发送。

依据：[OneBot 适配器的成员转换](https://github.com/koishijs/koishi-plugin-adapter-onebot/blob/main/src/utils.ts)。

## Telegram

使用 Koishi / Satori 官方 Telegram 适配器。插件通过 `bot.internal.getChatMember` 查询实际操作者在当前群内的身份，因为适配器的标准化成员对象未保留 Telegram 的管理员状态。

回复和主动通知均限制为实体解析后至多 4096 个 UTF-16 单元（对 emoji 保守计数），不拆成多条。两类结构化通知均省略公告原文、依据和原始来源链接，按标题、说明、时间信息、网站数据来源分块；块间留一空行。文本交给官方编码器进行 HTML 转义，转义后的实体长度不会错误地当成可见文本长度。[Telegram sendMessage](https://core.telegram.org/bots/api#sendmessage)

建议将机器人加入群并设为管理员；Telegram 仅保证管理员机器人能可靠查询其他用户的成员状态。若接口失败，插件不会放行群订阅或取消。[Telegram getChatMember](https://core.telegram.org/bots/api#getchatmember)

- 原生指令名使用 `/codexresetstatus`、`/codexresetsubscribe`、`/codexresetunsubscribe`，均选择英语。Telegram 原生指令名仅允许小写英文字母、数字和下划线。
- 开启适配器支持的原生指令注册后，可使用带机器人用户名的原生指令，例如 `/codexresetsubscribe@YourBot`；该用户名应替换为实际机器人名。
- 中文、日语、韩语及含连字符的英语别名通过普通消息入口识别。要在群里使用无前缀或这些文本别名，须保证 Telegram 会把消息交给机器人；检查 BotFather 隐私模式与机器人管理员设置。
- 私聊先打开机器人并发送 `/start`，再使用上述三条指令。阻止机器人后无法继续接收主动消息。

话题群中的订阅只作用于执行指令的当前话题，不覆盖群内其他话题。群号与话题号一起标识订阅，因此不同群中相同编号的话题可以分别订阅、选择语言和取消。权限仍检查操作者在所属群内的身份。普通群聊和私聊的用法不变。

主动通知携带所属群和话题的发送上下文，适配器据此设置 `chat_id` 和 `message_thread_id`；重置、预告与失败重试都使用同一目标。缺少所属群信息时拒绝注册群订阅，旧异常记录也不会猜测群号后发送。请使用能完整提供群与话题信息的官方适配器。[话题转换](https://github.com/satorijs/satori/blob/main/adapters/telegram/src/utils.ts)、[话题发送](https://github.com/satorijs/satori/blob/main/adapters/telegram/src/message.ts)

话题验收：

1. 在 A 群的一个话题订阅；在 B 群的同编号话题查询，应显示未订阅。在 B 群取消不影响 A 群。
2. 分别在两个话题用不同语言订阅，核对状态中的语言；同一群的另一个话题也应独立。
3. 等待真实预告或重置事件，确认通知进入对应话题。取消一个话题后，其他订阅继续生效；不额外发送测试消息。
4. 重启后核对已有订阅的语言和目标，确认不会重放已发送事件，待重试通知仍发送到原话题。实际投递还取决于机器人权限和话题是否可发送。

依据：[Telegram 适配器成员查询](https://github.com/satorijs/satori/blob/main/adapters/telegram/src/bot.ts)、[指令与成员转换](https://github.com/satorijs/satori/blob/main/adapters/telegram/src/utils.ts)、[Telegram Bot FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get)、[BotCommand 规则](https://core.telegram.org/bots/api#botcommand)。

## Discord

使用 Koishi / Satori 官方 Discord 适配器。插件通过适配器内部接口读取服务器、成员和角色：

1. 服务器 `owner_id` 与操作者一致时允许。
2. 否则合并成员角色与 `@everyone` 的权限位，只有包含 `ADMINISTRATOR`（值 `8`）才允许。
3. 单独拥有 `MANAGE_GUILD`（管理服务器）或名称为“admin”的角色，不视为管理员。

订阅属于执行指令的当前频道，不自动覆盖服务器其他频道。管理员身份并不保证机器人拥有该频道的发送权限，请同时检查机器人能否查看和发送消息。

原生入口使用 `/codexresetstatus`、`/codexresetsubscribe`、`/codexresetunsubscribe`，按适配器说明启用相应指令功能。使用普通消息别名时，还需确保适配器能读取消息正文；检查 Discord 的 Message Content Intent 和频道权限。私聊收发受用户的隐私设置限制。

状态回复和主动通知按官方适配器 Markdown 转义后的长度计算，最多 2000 个 UTF-16 单元，不拆成多条。主动通知省略公告原文、依据和原始来源链接，保留通知类型、时间及网站数据来源，并用空行分隔数据块。状态查询保留优先级选出的信号、最近三条历史、时区与订阅信息。

网站文字中的 `<@用户ID>`、`<@!用户ID>`、`<@&角色ID>`、`@everyone` 和 `@here` 会在 `@` 后插入零宽空格，显示为普通文字，避免通知意外提及用户或角色。Koishi 的消息元素标记也只作为文字输出。该规则适用于频道和私聊，以及首次发送和重试；不会额外发送测试消息。

依据：[Discord 消息长度限制](https://docs.discord.com/developers/resources/message#create-message)、[允许的提及](https://docs.discord.com/developers/resources/message#allowed-mentions-object)、[官方适配器文本转义](https://github.com/satorijs/satori/blob/main/adapters/discord/src/utils.ts)、[消息编码器](https://github.com/satorijs/satori/blob/main/adapters/discord/src/message.ts)。使用不同编码行为的第三方适配器时需重新验收。

Discord 验收：订阅后用状态指令检查语言与历史；遇到较长的真实预告或重置内容时，确认通知只有一条、包含关键时间与数据来源，网站公告原文、依据和原始来源链接不出现在通知中。取消后确认停止后续通知。自动化测试另行模拟超长文本、转义膨胀、Unicode 边界和发送失败重试，不向实际频道投递模拟数据。

依据：[Discord 适配器](https://github.com/satorijs/satori/blob/main/adapters/discord/src/bot.ts)、[Discord 权限](https://discord.com/developers/docs/topics/permissions)、[Message Content Intent](https://discord.com/developers/docs/events/gateway#message-content-intent)。

## Koishi 官方沙盒

官方 `@koishijs/plugin-sandbox` 的虚拟机器人没有网络登录过程，可能一直处于 `CONNECT`。插件允许该适配器的隐藏 `sandbox:` 机器人在此状态下主动发送；`OFFLINE`、`DISCONNECT` 仍不放行，其他适配器仍要求 `ONLINE`。发送必须返回消息 ID 才记为成功。

在沙盒私聊执行 `重置订阅开启` 可测试单条成功回复、正常预告／已执行提醒、重复订阅和取消。没有待执行预告或新重置时不会额外产生通知。沙盒群聊可以查询状态，但缺少平台群管理员身份，不能用用户等级 4 注册或取消群订阅。通过自动化夹具验证既有群订阅的投递路由，不建议手动改数据库创建群订阅。

自动化回归直接运行官方沙盒机器人和编码器，以内存控制台接收消息；不会连接真实聊天账号，也不会修改本机 Koishi 的用户权限。实际控制台测试需保持沙盒页面连接。

## 验收范围

主动推送仅包括明确预告和已执行重置；概率预测只在状态查询中显示，即使为 100% 也不推送。

自动化回归使用官方接口形状的模拟数据，覆盖群主、管理员、普通成员、错误身份、接口缺失、超时，以及角色被撤销后的拒绝操作；还通过 Koishi 数据库和消息编码器验证 Telegram 话题隔离、重置与预告路由、持久化数据恢复、写入中断恢复和发送去重。Discord 回归覆盖五语言状态与确认、频道及私聊推送、长度限制、原生提及和失败重试。不连接真实平台账号，不发送真实聊天消息。


实际部署仍需分别验证：普通成员能查询但不能管理群订阅、群管理员能订阅和取消、私聊三指令可用、订阅与取消各只有一条确认、各会话语言独立、真实事件只发到已订阅会话。具体步骤见 [Docker / QQ 验收](docker-qq-testing.md)，其他平台可按同样场景执行。成功的指令回复本身不能证明平台允许后续主动发送。
