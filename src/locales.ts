export const locales = ['en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR'] as const
export type Locale = typeof locales[number]
export type LanguageSetting = Locale | 'auto'
export const languageNames: Record<Locale, string> = {
  'en-US': 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', 'ja-JP': '日本語', 'ko-KR': '한국어',
}

// Columns follow `locales`. Keep plugin-owned text separate from upstream quotations.
const rows = {
  historyFailed: ["Recent reset history is temporarily unavailable.","暂时无法获取最近重置历史。","暫時無法取得最近重置歷史。","直近のリセット履歴を取得できません。","최근 리셋 기록을 일시적으로 가져올 수 없습니다."],
  historyTitle: ["Latest 3 resets (announcement / first observation time):","最近 3 次重置（公告／首次观察时间）：","最近 3 次重置（公告／首次觀察時間）：","直近3件のリセット（発表／初回観測日時）：","최근 리셋 3건 (공지 / 최초 관측 시각):"],
  roleUnavailable: ["Could not verify your group administrator permissions. Check the adapter and bot permissions, then retry. The subscription has not changed.","无法核验你的群管理权限，请检查适配器及机器人权限后重试。订阅未修改。","無法核驗你的群組管理權限，請檢查適配器與機器人權限後重試。訂閱未修改。","グループの管理権限を確認できません。アダプターとボットの権限を確認して再試行してください。購読は変更されていません。","그룹 관리 권한을 확인할 수 없습니다. 어댑터와 봇 권한을 확인한 뒤 다시 시도하세요. 구독은 변경되지 않았습니다."],
  groupUnsupported: ['Group subscription authorization is not supported for this adapter yet. The subscription has not changed.', '此适配器暂不支持群聊订阅权限校验。订阅未修改。', '此適配器暫不支援群組訂閱權限驗證。訂閱未修改。', 'このアダプターではグループの購読権限確認にまだ対応していません。購読は変更されていません。', '이 어댑터는 아직 그룹 구독 권한 확인을 지원하지 않습니다. 구독은 변경되지 않았습니다.'],
  qqNotConfigured: ['Official QQ groups require explicit authorization. Ask the bot operator to configure qqGroupManagers for this bot, group and user. The subscription has not changed.', 'QQ 官方群聊需要单独授权。请联系机器人维护者，在插件配置的 qqGroupManagers 中添加当前机器人、群和用户。订阅未修改。', 'QQ 官方群組需要個別授權。請聯絡機器人維護者，在外掛設定的 qqGroupManagers 中加入目前機器人、群組和使用者。訂閱未修改。', 'QQ 公式グループには個別の認可が必要です。ボット管理者に、このボット・グループ・ユーザーをプラグイン設定の qqGroupManagers に登録するよう依頼してください。購読は変更されていません。', 'QQ 공식 그룹은 별도 권한 부여가 필요합니다. 봇 운영자에게 플러그인 설정의 qqGroupManagers에 현재 봇, 그룹, 사용자를 등록해 달라고 요청하세요. 구독은 변경되지 않았습니다.'],
  qqNotAuthorized: ['You are not authorized to manage subscriptions in this QQ group. Contact the bot operator. The subscription has not changed.', '你未被授权管理当前 QQ 群的订阅，请联系机器人维护者。订阅未修改。', '你未獲授權管理目前 QQ 群組的訂閱，請聯絡機器人維護者。訂閱未修改。', 'この QQ グループの購読を管理する権限がありません。ボット管理者に連絡してください。購読は変更されていません。', '현재 QQ 그룹의 구독을 관리할 권한이 없습니다. 봇 운영자에게 문의하세요. 구독은 변경되지 않았습니다.'],
  adminOnly: ["Only the group owner or administrators can manage this conversation’s subscription.","只有群主或群管理员可以管理当前群聊的订阅。","只有群組擁有者或管理員可以管理目前群組的訂閱。","このグループの購読を管理できるのは所有者または管理者のみです。","그룹 소유자 또는 관리자만 이 그룹의 구독을 관리할 수 있습니다."],
  lowAuthority: ['Insufficient permissions.', '权限不足。', '權限不足。', '権限がありません。', '권한이 부족합니다.'],
  extraArguments: ['This command does not accept these additional arguments.', '此指令不接受这些额外参数。', '此指令不接受這些額外參數。', 'このコマンドでは追加の引数を指定できません。', '이 명령은 추가 인수를 받지 않습니다.'],
  unknownOptions: ['This command does not accept these options.', '此指令不接受这些选项。', '此指令不接受這些選項。', 'このコマンドではこれらのオプションを使用できません。', '이 명령은 해당 옵션을 지원하지 않습니다.'],
  operationFailed: ['The operation failed. Please try again later or check the plugin logs.', '操作失败，请稍后重试或查看插件日志。', '操作失敗，請稍後重試或查看外掛日誌。', '操作に失敗しました。時間を置いて再試行するか、プラグインのログを確認してください。', '작업에 실패했습니다. 나중에 다시 시도하거나 플러그인 로그를 확인하세요.'],
  context: ['Use this command in the channel or private chat that should receive notifications.', '请在需要接收推送的群聊或私聊中使用此指令。', '請在需要接收推送的群組或私訊中使用此指令。', '通知を受け取りたいグループまたは個別チャットで実行してください。', '알림을 받을 그룹 또는 개인 채팅에서 이 명령을 사용하세요.'],
  subscribed: ["Subscription successful. This conversation will receive announced-reset and executed-reset alerts. Notification language: {language}.","订阅成功，当前会话将接收重置预告和已执行重置提醒。推送语言：{language}。","訂閱成功，目前會話將接收重置預告與已執行重置通知。通知語言：{language}。","購読しました。このチャットにリセット予告と実行済みリセットを通知します。通知言語：{language}。","구독이 완료되었습니다. 이 채팅에 리셋 사전 공지와 실행된 리셋 알림을 보냅니다. 알림 언어: {language}."],
  already: ['Already subscribed; no duplicate subscription was created. Notification language: {language}.', '当前会话已订阅，无需重复订阅。推送语言：{language}。', '目前會話已訂閱，無需重複訂閱。推送語言：{language}。', 'すでに購読済みです。重複登録はしません。通知言語：{language}。', '이미 구독 중이므로 중복 구독을 만들지 않습니다. 알림 언어: {language}.'],
  unsubscribed: ["Cancellation successful. Reset notifications for this conversation have stopped.","取消成功，已停止当前会话的重置推送。","取消成功，已停止目前會話的重置推送。","購読を解除しました。このチャットへのリセット通知を停止しました。","구독을 취소했습니다. 이 채팅의 리셋 알림을 중지했습니다."],
  absent: ['This conversation is not subscribed.', '当前会话尚未订阅重置推送。', '目前會話尚未訂閱重置推送。', 'このチャットは未購読です。', '이 채팅은 구독 중이 아닙니다.'],
  subscription: ["This conversation is subscribed to receive reset announcements and executed-reset alerts.\nNotification language: {language}.","当前会话已订阅：接收重置预告和已执行重置提醒。\n推送语言：{language}。","目前會話已訂閱：接收重置預告與已執行重置通知。\n通知語言：{language}。","このチャットは購読中です。リセット予告と実行済みリセットの通知を受け取ります。\n通知言語：{language}。","이 채팅은 구독 중이며 리셋 사전 공지와 실행된 리셋 알림을 받습니다.\n알림 언어: {language}."],
  notSubscribed: ["This conversation is not subscribed.\nUse reset-subscribe to receive reset announcements and executed-reset alerts.","当前会话未订阅。\n发送「重置订阅开启」接收重置预告和已执行重置提醒。","目前會話未訂閱。\n傳送「重置訂閱開啟」接收重置預告與已執行重置通知。","このチャットは未購読です。\n「リセット購読」でリセット予告と実行済みリセットの通知を受け取れます。","이 채팅은 구독 중이 아닙니다.\n리셋구독으로 리셋 사전 공지와 실행된 리셋 알림을 받을 수 있습니다."],
  statusFailed: ['Reset status is temporarily unavailable. Try again later. Your subscription has not changed.', '暂时无法获取重置状态，请稍后重试。此查询不会改变订阅。', '暫時無法取得重置狀態，請稍後重試。此查詢不會變更訂閱。', 'リセット状況を取得できません。後でもう一度お試しください。購読設定は変更されません。', '리셋 상태를 가져올 수 없습니다. 나중에 다시 시도하세요. 구독 설정은 변경되지 않았습니다.'],
  help: ['Commands (with or without /):\n{commands}', '指令（可带 / 或不带前缀）：\n{commands}', '指令（可加 / 或不加前綴）：\n{commands}', 'コマンド（/ の有無は任意）：\n{commands}', '명령 (/ 접두사 생략 가능):\n{commands}'],
  subscribeDesc: ["Enable this conversation’s subscription to reset announcements and executed-reset alerts","开启当前会话订阅，接收重置预告和已执行重置提醒","開啟目前會話訂閱，接收重置預告與已執行重置通知","このチャットの購読を有効にしてリセット予告と実行済みリセットの通知を受け取る","이 채팅의 구독을 켜고 리셋 사전 공지와 실행된 리셋 알림 받기"],
  unsubscribeDesc: ["Disable this conversation’s subscription and stop reset alerts","关闭当前会话订阅，停止重置推送","關閉目前會話訂閱，停止重置通知","このチャットの購読を解除してリセット通知を停止","이 채팅의 구독을 끄고 리셋 알림 중지"],
  statusDesc: ["Show status, the latest three resets and this conversation’s subscription","查看当前状态、最近三次重置和当前会话订阅","查看目前狀態、最近三次重置與目前會話訂閱","現在の状況、直近3件のリセット、このチャットの購読状況を表示","현재 상태, 최근 리셋 3건 및 이 채팅의 구독 상태 확인"],
  attribution: ['Data source: https://codex-resets.com', '数据来源：https://codex-resets.com', '資料來源：https://codex-resets.com', 'データ提供：https://codex-resets.com', '데이터 출처: https://codex-resets.com'],
  scheduledTitle: ["[Codex reset announced]","【Codex 重置预告】","【Codex 重置預告】","【Codex リセット予告】","【Codex 리셋 사전 공지】"],
  scheduledPushNotice: ["An explicit reset announcement has been recorded; execution is not yet confirmed.","已发布明确的重置预告，尚未确认执行。","已發布明確的重置預告，尚未確認執行。","明確なリセット予告が記録されました。実行はまだ確認されていません。","명시적인 리셋 사전 공지가 기록되었습니다. 실행은 아직 확인되지 않았습니다."],
  resetType: ["Type: {value}","类型：{value}","類型：{value}","種類：{value}","유형: {value}"],
  scheduledAt: ["Scheduled for: {time}","预定时间：{time}","預定時間：{time}","予定日時：{time}","예정 시각: {time}"],
  resetTitle: ['[Codex reset executed]', '【Codex 已执行重置】', '【Codex 已執行重置】', '【Codex リセット実行済み】', '【Codex 리셋 실행됨】'],
  bankedTitle: ['[Codex banked reset credit issued]', '【Codex 储备重置已发放】', '【Codex 儲備重置已發放】', '【Codex ストック型リセットを付与】', '【Codex 저장형 리셋 지급】'],
  resetNotice: ['The website recorded a reset. Check your actual usage limits.', '网站记录了重置事件，请检查你的实际额度。', '網站記錄了重置事件，請確認你的實際額度。', 'サイトでリセットが記録されました。実際の利用枠を確認してください。', '웹사이트에 리셋이 기록되었습니다. 실제 사용 한도를 확인하세요.'],
  recordedAt: ['Reset recorded at: {time}', '重置记录时间：{time}', '重置記錄時間：{time}', 'リセット記録日時：{time}', '리셋 기록 시각: {time}'],
  strong: ['strong', '强', '強', '強い', '강함'],
  elevated: ['elevated', '较高', '較高', '高め', '높음'],
  unknown: ['not provided', '未提供', '未提供', '情報なし', '제공되지 않음'],
  expires: ['Valid until: {time}', '有效期至：{time}', '有效期限：{time}', '有効期限：{time}', '유효 기한: {time}'],
  statusTitle: ['[Codex reset status]', '【Codex 重置状态】', '【Codex 重置狀態】', '【Codex リセット状況】', '【Codex 리셋 상태】'],
  latest: ['Latest executed: {time} ({type})', '最近已执行：{time}（{type}）', '最近已執行：{time}（{type}）', '直近の実行：{time}（{type}）', '최근 실행: {time} ({type})'],
  regular: ['regular reset', '常规重置', '一般重置', '通常リセット', '일반 리셋'],
  banked: ['Banked Reset', '储备重置', '儲備重置', 'ストック型リセット', '저장형 리셋'],
  noReset: ['No executed resets recorded.', '暂无已执行重置记录', '暫無已執行重置紀錄', '実行済みリセットの記録はありません。', '실행된 리셋 기록이 없습니다.'],
  scheduled: ['Scheduled announcement: {time}', '待执行公告：{time}', '待執行公告：{time}', '実行予定の発表：{time}', '실행 예정 공지: {time}'],
  noSchedule: ['time not specified', '未给出预定时间', '未提供預定時間', '予定時刻の記載なし', '예정 시각 없음'],
  scheduledNotice: ['A scheduled time passing is not execution confirmation; wait for evidence.', '预定时间已到也不代表已完成，需等待执行证据。', '預定時間已到也不代表已完成，需等待執行證據。', '予定時刻を過ぎても実行済みとは限りません。実行の確認を待ってください。', '예정 시각이 지나도 실행이 확인된 것은 아닙니다. 실행 근거를 기다려야 합니다.'],
  activeWatch: ['Reset forecast: {level} | Probability {chance}', '重置预测：{level}｜概率 {chance}', '重置預測：{level}｜機率 {chance}', 'リセット予測：{level}｜確率 {chance}', '리셋 예측: {level}｜확률 {chance}'],
  forecastNotice: ['A forecast does not confirm execution.', '预测不代表已执行。', '預測不代表已執行。', '予測は実行済みを意味しません。', '예측은 실행 확인을 의미하지 않습니다.'],
  overviewTimeZone: ['All times above are in {zone}.', '以上时间均为 {zone}。', '以上時間均為 {zone}。', '上記の時刻はすべて {zone} です。', '위 시각은 모두 {zone} 기준입니다.'],
  noWatch: ['No active reset forecast.', '当前无有效重置预测。', '目前無有效重置預測。', '現在、有効なリセット予測はありません。', '현재 유효한 리셋 예측이 없습니다.'],
  auto: ['Follow the subscription command language', '自动跟随订阅指令语言', '自動跟隨訂閱指令語言', '購読コマンドの言語に合わせる', '구독 명령의 언어에 맞춤'],
  configLocale: ['Notification and reply language. Auto remembers each conversation’s subscription command language.', '通知和回复语言；自动模式记住每个会话的订阅指令语言。', '通知和回覆語言；自動模式記住每個會話的訂閱指令語言。', '通知と返信の言語。自動モードではチャットごとに購読コマンドの言語を保存します。', '알림 및 답변 언어. 자동 모드는 채팅별 구독 명령 언어를 저장합니다.'],
  configPoll: ['Polling interval in milliseconds (minimum 60 seconds).', '检查间隔（毫秒），最短 60 秒。', '檢查間隔（毫秒），最短 60 秒。', '確認間隔（ミリ秒）。最短 60 秒。', '확인 간격(밀리초). 최소 60초.'],
  configTimeout: ['API request timeout in milliseconds.', 'API 请求超时（毫秒）。', 'API 請求逾時（毫秒）。', 'API リクエストのタイムアウト（ミリ秒）。', 'API 요청 제한 시간(밀리초).'],
  configSend: ['Minimum interval between proactive sends in milliseconds.', '任意两次主动发送的最小间隔（毫秒）。', '任意兩次主動傳送的最短間隔（毫秒）。', '通知送信の最短間隔（ミリ秒）。', '알림 전송 사이의 최소 간격(밀리초).'],
  configQQManagers: ['Official QQ group subscription managers. Explicit grants scoped to a bot and group; this does not verify QQ administrator roles. Empty disables group management. Configuration alone does not subscribe.', 'QQ 官方群聊订阅管理授权：按机器人和群精确授权用户，不代表已核验 QQ 管理员身份。留空不开放群管理；配置本身不会创建订阅。', 'QQ 官方群組訂閱管理授權：依機器人和群組精確授權使用者，不代表已驗證 QQ 管理員身分。留空不開放群組管理；設定本身不會建立訂閱。', 'QQ 公式グループの購読管理権限。ボットとグループごとにユーザーを指定します。QQ 管理者の確認ではありません。空欄ではグループ管理を許可せず、設定だけでは購読しません。', 'QQ 공식 그룹 구독 관리 권한. 봇과 그룹별로 사용자를 지정하며 QQ 관리자 역할을 검증하는 것은 아닙니다. 비워 두면 그룹 관리를 허용하지 않으며 설정만으로 구독되지 않습니다.'],
  configQQSelf: ['Bot ID (session.selfId) for the official QQ adapter. Exact match; no wildcards.', '官方 QQ 适配器的机器人 ID（session.selfId），精确匹配，不支持通配符。', '官方 QQ 適配器的機器人 ID（session.selfId），精確比對，不支援萬用字元。', 'QQ 公式アダプターのボット ID（session.selfId）。完全一致のみで、ワイルドカードは使えません。', 'QQ 공식 어댑터의 봇 ID(session.selfId). 정확히 일치해야 하며 와일드카드는 지원하지 않습니다.'],
  configQQGroup: ['Group OpenID (session.guildId, equal to channelId), not the numeric QQ group number.', '群 OpenID（session.guildId，与 channelId 相同），不是普通 QQ 群号。', '群組 OpenID（session.guildId，與 channelId 相同），不是一般 QQ 群號。', 'グループ OpenID（session.guildId、channelId と同一）。通常の QQ グループ番号ではありません。', '그룹 OpenID(session.guildId, channelId와 동일). 일반 QQ 그룹 번호가 아닙니다.'],
  configQQUsers: ['Authorized member OpenIDs (session.userId from this group). Do not use QQ numbers, names or private-chat IDs; manage grants manually when roles change.', '授权用户 OpenID 列表（取自该群的 session.userId）。不要填写 QQ 号、昵称或私聊 ID；群角色变化后需手动调整授权。', '授權使用者 OpenID 清單（取自該群的 session.userId）。請勿填寫 QQ 號、暱稱或私訊 ID；群組角色變更後需手動調整授權。', '認可するメンバーの OpenID 一覧（このグループの session.userId）。QQ 番号・表示名・個別チャットの ID は使わず、役割変更時は手動で更新してください。', '허용할 멤버 OpenID 목록(해당 그룹의 session.userId). QQ 번호, 닉네임, 개인 채팅 ID는 사용하지 마세요. 그룹 역할이 바뀌면 권한을 수동으로 조정해야 합니다.'],
  timeZoneRule: ['Times follow the message language: Chinese UTC+8, Japanese/Korean UTC+9, English UTC.', '时间跟随文案语言：简繁中文 UTC+8，日语和韩语 UTC+9，英语 UTC。', '時間跟隨文案語言：簡繁中文 UTC+8，日語與韓語 UTC+9，英語 UTC。', '時刻はメッセージの言語に対応します：中国語 UTC+8、日本語・韓国語 UTC+9、英語 UTC。', '시간대는 메시지 언어를 따릅니다. 중국어 UTC+8, 일본어·한국어 UTC+9, 영어 UTC.'],
} satisfies Record<string, readonly [string, string, string, string, string]>

export type TextKey = keyof typeof rows
export function text(locale: Locale, key: TextKey, params: Record<string, string> = {}): string {
  return rows[key][locales.indexOf(locale)]!.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
}
export function descriptions(key: TextKey): Record<Locale, string> {
  return Object.fromEntries(locales.map(locale => [locale, text(locale, key)])) as Record<Locale, string>
}
export function parseLocale(value: string | undefined): Locale | undefined {
  const key = value?.toLowerCase()
  return locales.find(locale => locale.toLowerCase() === key)
    ?? ({ en: 'en-US', zh: 'zh-CN', 'zh-hans': 'zh-CN', 'zh-hant': 'zh-TW', ja: 'ja-JP', ko: 'ko-KR' } as Record<string, Locale>)[key ?? '']
}

export const commandNames = {
  status: ['reset-status', '重置状态', '重置狀態', 'リセット状況', '리셋상태'],
  subscribe: ['reset-subscribe', '重置订阅开启', '重置訂閱開啟', 'リセット購読', '리셋구독'],
  unsubscribe: ['reset-unsubscribe', '重置订阅关闭', '重置訂閱關閉', 'リセット購読解除', '리셋구독취소'],
} satisfies Record<string, readonly [string, string, string, string, string]>
export type ActionName = keyof typeof commandNames
