# Languages / 语言

指令回复、状态、主动通知和 Koishi 配置说明支持以下五种语言。三条指令均可直接发送，或添加 `/`、实例配置的前缀。

| Language | Locale | Status | Subscribe | Unsubscribe | Time zone |
| --- | --- | --- | --- | --- | --- |
| English | `en-US` | `reset-status` | `reset-subscribe` | `reset-unsubscribe` | UTC |
| 简体中文 | `zh-CN` | `重置状态` | `重置订阅开启` | `重置订阅关闭` | UTC+8 |
| 繁體中文 | `zh-TW` | `重置狀態` | `重置訂閱開啟` | `重置訂閱關閉` | UTC+8 |
| 日本語 | `ja-JP` | `リセット状況` | `リセット購読` | `リセット購読解除` | UTC+9 |
| 한국어 | `ko-KR` | `리셋상태` | `리셋구독` | `리셋구독취소` | UTC+9 |

## English

Send `reset-status` to see the current signal, the three most recent resets, and this conversation's subscription and notification language. The signal shows `scheduled_reset` first, otherwise an unexpired `active_watch`, otherwise no valid forecast. A scheduled time passing does not prove execution. Queries do not subscribe or change the saved language.

Send `reset-subscribe` to receive explicit reset announcements and executed-reset alerts in English. Probability forecasts are only shown in status queries, even at 100%. Send `reset-unsubscribe` to stop notifications and clear pending deliveries for this conversation. Each successful operation returns one confirmation without an extra test message.

Anyone can query status. QQ (OneBot), Telegram and Discord require platform group owners or administrators for group/channel subscriptions. Official QQ groups instead require explicit operator grants in `qqGroupManagers`, scoped to a bot, group and user; these do not verify QQ roles. All three commands are available in private chats. Koishi authority levels do not grant group management access. Telegram topics and Discord channels have independent subscriptions. English timestamps use UTC. The reset record time comes from `announced_at`, an announcement or first-observation time, not necessarily the exact execution time.

## 简体中文

发送 `重置状态` 查看当前信号、最近 3 条重置历史、会话订阅状态和推送语言。信号优先显示 `scheduled_reset`；没有公告才显示未过期的 `active_watch`；两者都没有则提示无有效预测。预定时间已到不代表已执行。查询不会开启订阅或改变保存的语言。

发送 `重置订阅开启`，接收中文重置预告和已执行重置提醒；概率预测只用于状态查询，100% 也不主动推送。发送 `重置订阅关闭` 停止当前会话推送并清除待发、待重试消息。两种成功操作各回复一条确认，不额外发送测试消息。

状态查询所有用户可用；QQ（OneBot）、Telegram、Discord 的群聊或频道订阅开关仅限平台群主／管理员。QQ 官方群使用维护者在 `qqGroupManagers` 中按机器人、群和用户配置的显式授权，不核验 QQ 角色。私聊三条指令全部可用。提高 Koishi 用户等级不会获得群管理授权。Telegram 话题和 Discord 频道各自独立订阅。简体中文时间使用 UTC+8。“重置记录时间”取自 `announced_at`，表示公告或首次观察时间，不一定是精确执行时刻。

## 繁體中文

傳送 `重置狀態` 查看目前訊號、最近 3 筆重置歷史、會話訂閱狀態與通知語言。優先顯示 `scheduled_reset`；沒有公告才顯示未過期的 `active_watch`；兩者都沒有則提示無有效預測。預定時間已到不代表已執行。查詢不會開啟訂閱或改變儲存的語言。

傳送 `重置訂閱開啟`，接收繁體中文重置預告與已執行重置通知；機率預測只用於狀態查詢，100% 也不主動推送。傳送 `重置訂閱關閉` 停止目前會話推送，並清除待傳送與待重試通知。兩種成功操作各回覆一則確認，不額外傳送測試訊息。

所有使用者都能查詢狀態；QQ（OneBot）、Telegram、Discord 的群組或頻道訂閱開關僅限平台群主／管理員。QQ 官方群組使用維護者在 `qqGroupManagers` 中依機器人、群組和使用者設定的明確授權，不驗證 QQ 角色。私訊三條指令皆可使用。提高 Koishi 使用者等級不會取得群組管理授權。Telegram 話題與 Discord 頻道各自獨立訂閱。繁體中文時間使用 UTC+8。「重置記錄時間」取自 `announced_at`，表示公告或首次觀察時間，不一定是精確執行時刻。

## 日本語

`リセット状況` で現在のシグナル、直近 3 件のリセット履歴、チャットの購読状態と通知言語を確認できます。`scheduled_reset` を優先し、予告がない場合は有効期限内の `active_watch`、どちらもない場合は有効な予測がない旨を表示します。予定時刻を過ぎても実行済みとは判断しません。照会で購読状態や保存された言語は変わりません。

`リセット購読` で明確なリセット予告と実行済みリセットの通知を日本語で受け取れます。確率予測は 100% でも自動送信せず、状況照会にのみ表示します。`リセット購読解除` でこのチャットへの通知を停止し、送信待ち・再試行待ちの通知を削除します。成功時はそれぞれ確認を 1 件だけ返し、追加のテスト通知は送りません。

状況照会は全ユーザーが利用できます。QQ（OneBot）、Telegram、Discord のグループ・チャンネル購読操作はプラットフォーム上の所有者・管理者に限ります。QQ 公式グループではボット管理者が `qqGroupManagers` にボット・グループ・ユーザーを指定して認可します。QQ の役割確認ではありません。個別チャットでは 3 つのコマンドをすべて利用でき、Koishi の権限レベルだけではグループ管理を許可しません。Telegram のトピックと Discord のチャンネルは個別に購読します。日本語の時刻表示は UTC+9 です。記録時刻は `announced_at` に基づく告知・初回観測時刻であり、正確な実行時刻とは限りません。

## 한국어

`리셋상태`로 현재 신호, 최근 리셋 기록 3건, 이 채팅의 구독 상태와 알림 언어를 확인합니다. `scheduled_reset`을 우선 표시하고, 사전 공지가 없으면 만료되지 않은 `active_watch`를 표시합니다. 둘 다 없으면 유효한 예측이 없다고 안내합니다. 예정 시각이 지났다는 이유만으로 실행됐다고 판단하지 않습니다. 조회는 구독 상태나 저장된 언어를 바꾸지 않습니다.

`리셋구독`으로 명시적인 리셋 사전 공지와 실행된 리셋 알림을 한국어로 받습니다. 확률 예측은 100%라도 자동으로 보내지 않고 상태 조회에만 표시합니다. `리셋구독취소`로 이 채팅의 알림을 중지하고 전송 및 재시도 대기 중인 알림을 삭제합니다. 성공 시 각각 확인 메시지 한 건만 보내며 추가 테스트 알림은 보내지 않습니다.

상태 조회는 누구나 사용할 수 있습니다. QQ(OneBot), Telegram, Discord의 그룹 및 채널 구독 관리는 플랫폼 소유자 또는 관리자만 가능합니다. QQ 공식 그룹은 봇 운영자가 `qqGroupManagers`에 봇, 그룹, 사용자를 지정하여 별도 권한을 부여하며 QQ 역할을 검증하지 않습니다. 개인 채팅에서는 세 명령을 모두 사용할 수 있고 Koishi 권한 등급만으로 그룹 관리 권한을 얻을 수는 없습니다. Telegram 토픽과 Discord 채널은 각각 독립적으로 구독합니다. 한국어 시각은 UTC+9로 표시합니다. 기록 시각은 `announced_at`의 공지 또는 최초 관측 시각이며 정확한 실행 시각과 다를 수 있습니다.

## Banked Reset / 储备重置

`banked` 表示储备重置额度的发放；通知不表示用户已经立即使用该额度。预告、状态和历史使用相同的类型名称。

| Language | Type | Issuance notification title |
| --- | --- | --- |
| English | Banked Reset | [Codex banked reset credit issued] |
| 简体中文 | 储备重置 | 【Codex 储备重置已发放】 |
| 繁體中文 | 儲備重置 | 【Codex 儲備重置已發放】 |
| 日本語 | ストック型リセット | 【Codex ストック型リセットを付与】 |
| 한국어 | 저장형 리셋 | 【Codex 저장형 리셋 지급】 |

## Configuration / 配置

```yaml
plugins:
  codex-resets:
    locale: auto
```

Available values: `auto`, `en-US`, `zh-CN`, `zh-TW`, `ja-JP`, `ko-KR`. Configuration descriptions follow the Koishi console language. A fixed language applies to all replies and notifications; returning to `auto` restores each conversation's saved preference.

With `locale: auto`, the subscription command selects and saves the notification language. Repeating it in another language updates the preference without replaying delivered events. Query and unsubscribe replies follow the invoked command's language; queries do not change the notification language. Pending structured notifications use the current notification language when sent. Changing language does not reset retry progress.

默认 `locale: auto` 按订阅指令保存推送语言。再次用另一种语言订阅可更改语言，不重放已发送事件；状态查询和关闭订阅按本次指令语言回复。固定 `locale` 对所有回复与推送生效，切回 `auto` 后恢复各会话保存的语言。时间随最终文案语言转换，不受服务器时区或夏令时影响。

Native slash commands are `codexresetstatus`, `codexresetsubscribe` and `codexresetunsubscribe`; all select English. Text aliases `codex-reset.status`, `codex-reset.subscribe` and `codex-reset.unsubscribe` also select English. All entry points respect Koishi command permissions and alias filters.

两类主动通知按标题、说明、时间信息、网站数据来源分块，块间留一空行。参见[状态文案](status-messages.md)、[主动推送文案](notification-messages.md)、[平台与权限](platforms.md)及 [Docker / QQ 验收步骤](docker-qq-testing.md)。

## 时区与显示细节 / Time zones

时区跟随最终文案语言，无需增加指令或参数。例如日语订阅后使用英语查询，查询显示 UTC，后续日语推送仍显示 UTC+9。状态消息统一标注一次时区，主动通知在时间旁标注；公告时间、历史记录、预定时间和预测有效期均按此转换，不受服务器／Docker 时区和夏令时影响。

API 日期时间字段按其携带的偏移解析；英语统一转换为 UTC，不采用太平洋时间。转换只改变显示，不改变事件时间、预测有效期、去重或重试记录。时间格式的严格校验和异常处理见 [API 时间校验](api.md#api-时间校验)。

Time zones follow the final message language. For example, after subscribing in Japanese, an English status query uses UTC while subsequent Japanese notifications still use UTC+9. Formatting does not change event timing, expiry, deduplication or retries, and does not depend on the server time zone or daylight saving time.

原生指令没有消息正文时，仍按实际执行的指令名识别语言；实例前缀与别名开头重合时，也保留无前缀指令的语言。配置说明随 Koishi 控制台语言显示对应译文。
