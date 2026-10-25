# 开发与本地打包

## 构建与回归验证

在源码项目目录中，使用 Node.js 22.12 或以上运行：

```sh
npm ci
npm run check
```

两条命令均成功后再打包。`npm run check` 会构建分发文件并运行完整回归；`npm run release:pack` 只打包和校验，不代替前面的构建／测试。

测试不访问真实 API、不发送真实聊天消息，覆盖会话隔离、显式订阅、缓存基线、预告与执行提醒、待执行公告恢复、分页补查、数据库去重、取消与发送并发、旧预告撤销、重试、单条成功回复、五语言与原生指令、QQ / Telegram / Discord 权限、Telegram 话题隔离与发送路由、持久化数据恢复、最近三条历史缓存、严格时间校验、预告去重、Discord 五语言限长与原生提及处理、精简状态模板、官方沙盒 CONNECT 投递、官方 Telegram 编码器限长与重试、跨服务器时区一致性、请求间隔、限流状态写入失败和恢复、Koishi 指令集成。平台权限回归使用符合官方适配器接口的数据模拟，未连接实际 QQ、Telegram 或 Discord 账号；实际收发还需在你的部署中验证。单实例运行与持久化要求见[推送规则](notifications.md)。

修改 GitHub 工作流时，提交前另需运行 `actionlint .github/workflows/publish.yml`，检查表达式和上下文。仅能解析 YAML 不代表 GitHub 能执行该工作流。

## 临时目录打包

每次本地验证都创建新的临时目录，并通过 `RELEASE_DIR` 指定输出位置。不要在项目根目录直接运行 `npm pack`，以免覆盖已有同名正式安装包。工作分支即使暂未修改版本号，其测试包内容也可能已与 npm／GitHub 发布附件不同。

Linux / macOS（sh、bash、zsh）：

```sh
export RELEASE_DIR="$(mktemp -d)"
npm run release:pack
```

Windows PowerShell：

```powershell
$env:RELEASE_DIR = Join-Path ([IO.Path]::GetTempPath()) ('codex-resets-pack-' + [guid]::NewGuid().ToString('N'))
npm run release:pack
```

仅使用校验成功的安装包。输出文件为 `RELEASE_DIR` 下的 `koishi-plugin-codex-resets-<当前版本>.tgz`；脚本同时输出版本和 SHA-256，并检查包内文件范围、入口、清单一致性及疑似隐私信息。需要再次打包时，重新执行对应系统的临时目录设置命令。

此流程不修改版本、不创建标签、不发布 npm，也不覆盖项目根目录的正式包。测试包仅用于本地验收，不应替换同版本的已发布附件；安装方式见[使用与配置](usage.md#使用本地安装包)。

## 发布边界

完成修改后进行本地 Git 提交；普通提交与推送只保存或同步代码，不创建版本或触发 CI。只有维护者明确决定发布新版本，才更新版本、创建标签并正式发布 GitHub Release。可信发布绑定、CI 顺序、失败重跑与手动备用发布见[发布与验证](publishing.md)。
