# koishi-plugin-codex-resets

为 Koishi 群聊、频道和私聊提供 Codex 重置通知。**只有通过指令订阅的会话才会收到重置预告和已执行重置提醒**；概率预测仅在状态查询中显示。数据来自 [Codex Resets](https://codex-resets.com)。

Codex reset notifications for Koishi groups, channels and private chats. **Only subscribed conversations receive reset announcements and executed-reset alerts**; probability forecasts appear only in status queries. Data is provided by [Codex Resets](https://codex-resets.com).

## 安装 / Installation

在 Koishi 控制台的「插件市场」搜索 **codex-resets**，安装后在「插件配置」中添加并启用。需要 **Node.js ≥ 22.12、Koishi ^4.18.11**，以及可用的 `http` 服务和持久化数据库。

Search for **codex-resets** in the Koishi Plugin Market, install it, then add and enable it in Plugin Configuration. Requires **Node.js ≥ 22.12, Koishi ^4.18.11**, the `http` service and a persistent database.

## 使用 / Usage

在希望接收通知的会话中发送指令，可使用 `/`、实例前缀或不带前缀。

Send a command in the conversation that should receive notifications. Commands accept `/`, your instance prefix, or no prefix.

| 中文指令 | English command | 功能 / Action |
| --- | --- | --- |
| `重置状态` | `reset-status` | 查询状态、最近 3 条历史和订阅信息 / Show status, the latest 3 resets and subscription details |
| `重置订阅开启` | `reset-subscribe` | 开启当前会话的两类重置提醒 / Enable both types of reset alerts for this conversation |
| `重置订阅关闭` | `reset-unsubscribe` | 关闭当前会话的重置提醒 / Disable reset alerts for this conversation |

所有用户可查询状态；群聊／频道的订阅开关仅限平台群主或管理员，私聊三条指令全部可用。群权限校验支持 **QQ（OneBot）、Telegram、Discord**，具体限制见[平台与权限](docs/platforms.md)。

Anyone can query status. Only platform group owners or administrators can manage group/channel subscriptions; all three commands are available in private chats. Group permission checks support **QQ (OneBot), Telegram and Discord**; see [platform requirements](docs/platforms.md).

支持 **English、简体中文、繁體中文、日本語、한국어**。默认按订阅指令保存推送语言，也可在配置中固定语言。简繁中文使用 UTC+8，日语和韩语使用 UTC+9，英语使用 UTC。

Supports **English, Simplified Chinese, Traditional Chinese, Japanese and Korean**. By default, the subscription command selects the notification language; configuration can override it. Times use UTC+8 for Chinese, UTC+9 for Japanese/Korean, and UTC for English.

## 文档 / Documentation

| 文档 / Guide | 内容 / Contents |
| --- | --- |
| [使用与配置 / Usage and configuration](docs/usage.md) | 安装更新、指令与配置项 / Installation, updates, commands and settings |
| [语言指南 / Languages](docs/languages.md) | 五语言指令、语言切换与时区 / Commands in all five languages, language selection and time zones |
| [平台与权限 / Platforms and permissions](docs/platforms.md) | QQ、Telegram、Discord 与沙盒 / QQ, Telegram, Discord and sandbox requirements |
| [推送规则 / Notification behavior](docs/notifications.md) | 基线、去重、持久化与重试 / Baselines, deduplication, persistence and retries |
| [状态文案 / Status messages](docs/status-messages.md) | 查询结果示例 / Status response examples |
| [主动推送文案 / Notification messages](docs/notification-messages.md) | 预告、执行与订阅确认 / Announcements, executed resets and subscription confirmations |
| [Docker / QQ 验收 / Docker and QQ testing](docs/docker-qq-testing.md) | 部署与实际会话测试 / Deployment and conversation testing |
| [API 与故障恢复 / API and recovery](docs/api.md) | 接口、时间校验、限流与请求恢复 / Endpoints, timestamps, rate limits and request recovery |
| [开发与打包 / Development and packaging](docs/development.md) | 回归测试与临时目录打包 / Regression tests and packaging in a temporary directory |
| [发布与验证 / Publishing and verification](docs/publishing.md) | GitHub Release → npm 流程 / GitHub Release → npm workflow |

[MIT License](LICENSE)
