# Linux / Docker / QQ 安装与实测

以下以容器名 `koishi`、应用目录 `/koishi` 为例。请先用 `docker ps` 确认自己的容器名。官方镜像使用 `/koishi` 保存应用文件；其他镜像请使用实际包含 `koishi.yml` 和 `package.json` 的目录。[Koishi Docker 文档](https://koishi.chat/en-US/manual/starter/docker)

## 通过插件市场安装和更新

插件公开发布到 npm 并被市场收录后，可直接在 Koishi 控制台“插件市场”搜索 `codex-resets` 安装，再到“插件配置”启用，无需上传安装包。后续从市场更新即可。以下安装包步骤用于发布前测试或需要手动安装的场景。

从本地 `.tgz` 切换到 npm 注册表版本时，在容器 `/koishi` 中使用实例现有的包管理器执行下面对应的一条命令，然后重启容器：

- npm：`npm install koishi-plugin-codex-resets@latest --registry https://registry.npmjs.org/`
- Yarn 1：`yarn add -W koishi-plugin-codex-resets@latest`
- Yarn 2 及以上：`yarn add koishi-plugin-codex-resets@latest`
- pnpm 工作区：`pnpm add -w koishi-plugin-codex-resets@latest`

切换安装来源不会删除数据库中的订阅。首次发布的检索和安装可能受到市场索引、注册表镜像同步时间的影响。

## 1. 上传安装包

从项目 `packages/releases/` 选择正式 `koishi-plugin-codex-resets-0.5.2.tgz`，或从 `packages/test/` 的指定构建目录选择测试包，通过 SFTP 或 scp 上传到 Linux 服务器的 `/tmp/` 作为传输暂存。这是已经编译好的安装包，服务器无需克隆源码或安装 TypeScript；本地项目不再把安装包保存在根目录。

在 Linux 服务器执行：

```sh
docker ps --format 'table {{.Names}}\t{{.Image}}'
docker exec koishi node -v
docker exec -w /koishi koishi node -p "require('koishi/package.json').version"
docker inspect koishi --format '{{json .Mounts}}'
```

插件要求 Node.js 22.12 或以上、Koishi 4.18.11 或兼容的 4.x 版本。检查挂载列表，应用文件和 SQLite 数据库所在目录需要持久化；使用官方镜像时通常挂载整个 `/koishi`。保留现有的数据库和适配器配置。

## 2. 将安装包保存在应用目录

```sh
docker exec -w /koishi koishi mkdir -p vendor
docker cp /tmp/koishi-plugin-codex-resets-0.5.2.tgz koishi:/koishi/vendor/
docker exec -it -w /koishi koishi sh
```

最后一条进入容器里的 Koishi 应用目录。后续安装命令在这个 shell 中运行。包保存在应用目录的 `vendor/`，便于容器重建后根据相对路径重新安装。

## 3. 使用实例现有的包管理器安装

查看 `package.json` 中的 `packageManager` 和已有锁文件，选择下面对应的一条命令。

| 实例使用的管理器 | 在容器 `/koishi` 中执行 |
| --- | --- |
| npm（`package-lock.json`） | `npm install ./vendor/koishi-plugin-codex-resets-0.5.2.tgz` |
| Yarn 1（`yarn -v` 以 `1.` 开头） | `yarn add -W file:./vendor/koishi-plugin-codex-resets-0.5.2.tgz` |
| Yarn 2 及以上 | `yarn add koishi-plugin-codex-resets@file:./vendor/koishi-plugin-codex-resets-0.5.2.tgz` |
| pnpm 工作区 | `pnpm add -w ./vendor/koishi-plugin-codex-resets-0.5.2.tgz` |

Yarn 1 的 `-W` 用于安装到工作区根目录；Yarn 2 及以上不需要该参数。[Yarn 1 文档](https://classic.yarnpkg.com/lang/en/docs/cli/add/)、[Yarn 文档](https://yarnpkg.com/cli/add)

安装完成后退出容器 shell，并在服务器重启 Koishi 容器：

```sh
exit
docker restart koishi
```

更新插件时，使用相同方式安装新版本并重启容器，数据库中的订阅会保留。

## 4. 在控制台启用插件

打开现有 Koishi 控制台，在“插件配置”中添加 `codex-resets` 并启用。若提示等待依赖，先启用：

- `http` 服务。
- 持久化数据库，例如 `database-sqlite`、MySQL 或 PostgreSQL。
- 已在线的 QQ 适配器。OneBot 须能提供群成员角色；官方 `adapter-qq` 优先使用事件角色或成员查询接口，角色不可用时再按[QQ 官方适配器配置](platforms.md#qq-官方适配器)设置 `qqGroupManagers` 备用授权。不要用 AppID 代替 selfId，也不能填写普通 QQ 号和群号。

默认检查间隔 5 分钟。新订阅会唤醒正常检查；只回复一条订阅确认，不发送额外测试消息。首次检查可能发送网站当前仍待执行的真实预告，已有的已执行重置默认不补发。

插件指令同时支持 `/`、无前缀和原有实例前缀。语言默认 `locale: auto`，按订阅指令保存。控制台可统一选择 English、简体中文、繁體中文、日本語或 한국어；[语言速查](languages.md)列出了全部指令。

显示时区自动跟随文案语言：简繁中文 UTC+8，日语和韩语 UTC+9，英语 UTC。固定 `locale` 会同时固定语言和对应时区，无需修改容器的系统时区。状态查询所有人可用；OneBot 和 QQ 官方群均校验实际群主／管理员，QQ 官方群角色不可用时可使用维护者的备用授权；私聊三种指令全部开放。各适配器的限制见[平台与权限](platforms.md)。

## 5. 按顺序测试

准备一个 QQ 测试群 A、一个普通成员账号、一个群主／管理员账号，以及与机器人的私聊。每条指令单独发送。下表假设这两个会话开始均未订阅；已有订阅可先由群管理员或私聊用户发送 `重置订阅关闭`。

下表适用于 OneBot 和能提供角色的官方 `adapter-qq`。官方 QQ 另需验证：无人工名单时管理员仍能操作；已确认的普通成员即使在名单中也被拒绝；管理员降为普通成员后不能关闭或开启订阅。仅在角色不可用时测试备用名单：无该机器人／群条目则提示检查接口或配置备用授权，有条目但用户不在名单中则提示未授权；其他群／机器人不能借用授权，配置本身不创建订阅。撤销备用授权不会取消已有订阅；平台角色不可用时名单必须手动维护。

| 场景 | 会话和指令 | 预期结果 |
| --- | --- | --- |
| 未注册查询 | 普通成员在群 A：`重置状态` | 显示状态、最近最多 3 条历史和未订阅；不注册 |
| 群权限拒绝 | 普通成员在群 A：`重置订阅开启`、`重置订阅关闭` | 提示仅限群主／管理员，不改订阅 |
| 注册群聊 | 管理员在群 A：`重置订阅开启` | 一条简体中文订阅成功确认，不附加测试消息 |
| 重复订阅 | 管理员在群 A：`/重置订阅开启` | 一条已订阅确认；不重复注册 |
| 私聊独立 | 私聊：`重置状态` | 仍未订阅 |
| 私聊注册 | 私聊：`/reset-subscribe` | 一条英语成功确认，不附加测试消息 |
| 无权取消 | 普通成员在群 A：`重置订阅关闭` | 拒绝；再次查询仍已订阅 |
| 群聊切换语言 | 管理员在群 A：`/重置訂閱開啟`，再 `重置狀態` | 一条繁体订阅确认；状态显示繁体推送语言，私聊仍英语 |
| 查询不切换语言 | 群 A：`/reset-status` | 英语查询回复，时间标注 UTC；保存的推送语言仍繁体，后续推送使用 UTC+8 |
| 取消群聊 | 管理员在群 A：`重置訂閱關閉` | 一条繁体取消成功确认，清除群内待发送及待重试消息；若使用简体关闭指令，则回复简体 |
| 私聊不受影响 | 私聊：`reset-status` | 仍显示已订阅，英语推送语言 |
| 重启持久化 | 重启容器后在两处查询状态 | 群 A 未订阅，私聊仍已订阅 |
| 固定语言 | 临时配置 `locale: ko-KR` 后查询 | 插件回复为韩语，时间标注 UTC+09:00；改回 `auto` 后恢复会话语言及对应时区 |
| 私聊取消 | 私聊：`/reset-unsubscribe` | 一条英语取消成功确认 |
| 重复取消 | 私聊再发 `reset-unsubscribe` | 如实提示当前会话未订阅 |

不能确认群身份时应提示无法验证权限，并保持订阅不变。管理员即使 Koishi 用户等级为 0 也可操作；普通成员即使 Koishi 用户等级较高仍不能管理群订阅。实例额外配置的全局权限或会话过滤可进一步限制指令。

指令入口验收：

- 在指令管理中暂时禁用 `重置订阅开启` 这个别名，以管理员分别发送 `重置订阅开启`、`/重置订阅开启` 及实例前缀形式，均不应创建订阅；恢复该别名后应能订阅。同样验证关闭别名被禁用时不能取消已有订阅，完成后恢复配置并取消测试订阅。
- 使用实例前缀测试错误语言；例如实例前缀为 `!`、`locale: auto` 时，`!reset-subscribe extra` 应回复英语参数错误，`!重置訂閱開啟 extra` 应回复繁体中文参数错误。状态、开启和关闭都不接受额外参数。
- 临时设置 `locale: ko-KR`，发送 `!重置订阅开启 --unknown` 应回复“이 명령은 해당 옵션을 지원하지 않습니다.”，订阅不变。测试后恢复原语言配置。无前缀和 `/` 兼容入口仍只接收完整指令，不应执行附带额外参数的消息。

## 6. 验证真实主动推送

验证主动发送时，在希望接收消息的测试会话重新订阅，等待网站出现待执行预告或新执行记录：

1. 查询 `重置状态`，核对当前会话已订阅及推送语言。
2. 当前已有待执行预告时，首次正常检查应推送该预告；没有待执行预告或新执行记录时，没有主动消息是正常现象。
   概率预测（包括 100%）只在状态查询中显示，不主动发送。
3. 网站出现新执行记录后，等待正常轮询，检查已订阅群与私聊是否收到各自语言的提醒；未订阅会话不应收到。
4. 取消群订阅，保留私聊订阅，下一次真实事件应只发送给私聊。测试完毕后分别取消订阅。

历史查询不会触发历史补发。取消成功后不再向旧订阅周期提交排队消息，但已经进入适配器发送流程的消息无法撤回。成功的订阅确认只证明指令和订阅写入成功，不代表已经验证主动发送权限。

## 7. 排查问题

查看 Koishi 控制台的 `codex-resets` 日志，或在服务器执行：

```sh
docker logs --tail 150 koishi
```

- 指令没有回复：检查插件依赖、机器人连接、会话过滤和平台消息接收设置，尝试完整发送 `/重置状态`，避免 @其他机器人或引用消息。
- 提示只允许管理员：检查操作者是否为当前群主或管理员；提高 Koishi 用户等级不会改变群身份。
- QQ 官方群提示无法获取角色：检查适配器版本及成员接口权限，必要时由维护者核实管理员身份后配置备用授权。`selfId` 必须是登录机器人 ID，不是 AppID；群和成员使用本次群会话的 OpenID。提示未授权时检查备用名单，提高 Koishi 等级不会解决。已确认的普通成员不能通过名单放行。
- 提示适配器暂不支持：当前平台未实现群权限校验；不要用群角色名称或高 Koishi 等级替代平台适配。
- 提示无法验证身份：确认角色或会话标识完整、平台接口可用；Telegram / Discord 的专属要求见[平台说明](platforms.md)。
- 状态显示未订阅：需要在当前群、频道或私聊注册；一个会话的订阅不会替代另一个会话。
- 状态或历史暂不可用：检查容器网络、代理和 API 日志；两类结果独立显示，首次查询还可能等待至少 5 秒的共享请求间隔。
- 日志提示 API 状态字段或历史响应格式不正确：插件拒绝缺少明确时区、日期不存在等异常时间。检查上游时间是否包含 `Z` 或 `±HH:MM`，等待上游恢复及退避重试；无需修改容器时区或重新订阅。详见 [API 时间校验](api.md#api-时间校验)。
- 已订阅但没有主动消息：先确认网站存在待执行预告或订阅后新发生的重置，再检查机器人在线、频道发送权限、私聊创建能力与发送失败日志。[Koishi 消息 API](https://koishi.chat/en-US/api/resources/message)
- 日志显示“数据库中存在未完成的 API 请求”：按 [API 请求状态恢复](api.md#api-请求状态恢复) 检查数据库和已确认的退避期限。反复重启不会解除暂停；订阅、取消和本地订阅状态仍可用。
