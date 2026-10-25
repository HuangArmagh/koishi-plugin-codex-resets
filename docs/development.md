# 开发与本地打包

## 构建与回归验证

在源码项目目录中，使用 Node.js 22.12 或以上运行：

```sh
npm ci
npm run check
```

两条命令均成功后再打包。`npm run check` 会构建分发文件并运行完整回归；`npm run release:pack` 只打包和校验，不代替前面的构建／测试。

测试不访问真实 API、不发送真实聊天消息，覆盖会话隔离、显式订阅、缓存基线、预告与执行提醒、待执行公告恢复、分页补查、数据库去重、取消与发送并发、旧预告撤销、重试、单条成功回复、五语言与原生指令、QQ / Telegram / Discord 权限、Telegram 话题隔离与发送路由、持久化数据恢复、最近三条历史缓存、严格时间校验、预告去重、Discord 五语言限长与原生提及处理、精简状态模板、官方沙盒 CONNECT 投递、官方 Telegram 编码器限长与重试、跨服务器时区一致性、请求间隔、限流状态写入失败和恢复、Koishi 指令集成。平台权限回归使用符合官方适配器接口的数据模拟，未连接实际 QQ、Telegram 或 Discord 账号；实际收发还需在你的部署中验证。单实例运行与持久化要求见[推送规则](notifications.md)。

QQ 官方群的回归额外覆盖：默认拒绝、机器人／群／用户精确授权、跨群和跨机器人隔离、配置撤销、无角色事件、五语言三种前缀、私聊与公开状态、原有权限过滤、两类通知与取消，以及配置校验。模拟平台标识不会证明 QQ 官方允许主动发送，云端仍需按实际账号权限验收。测试只使用虚构标识，真实授权名单应保存在 Koishi 实例配置中。

修改 GitHub 工作流时，提交前另需运行 `actionlint .github/workflows/publish.yml`，检查表达式和上下文。仅能解析 YAML 不代表 GitHub 能执行该工作流。

## 项目内安装包目录

所有安装包统一放在项目内的 `packages/`，不放项目根目录或系统临时目录。目录不提交 Git，也不会进入 npm 包：

```text
packages/
  releases/                 原始正式安装包（保留发布时的字节）
  test/<版本>-<时间>-<后缀>/  每次本地验证的独立安装包
  ci/                       GitHub Actions 的构建和发布包
```

完成构建与测试后直接运行，无需预先配置路径：

```sh
npm run release:pack
```

脚本默认在 `packages/test/` 下创建独立目录，输出包的相对路径、版本和 SHA-256。即使版本号没有变化，也不会覆盖已有测试包或正式包。包通过文件范围、入口、清单一致性及疑似隐私信息检查后才保存到目标位置。

若以前设置过 `RELEASE_DIR`，先清除该环境变量以使用默认路径：PowerShell 使用 `Remove-Item Env:RELEASE_DIR -ErrorAction SilentlyContinue`，sh/bash/zsh 使用 `unset RELEASE_DIR`。需要指定目录时，必须选择 `packages/` 内的子目录，例如 PowerShell：

```powershell
$env:RELEASE_DIR = 'packages/manual-check'
npm run release:pack
```

目标已有同名 `.tgz` 时脚本会拒绝覆盖；请换新目录或清除环境变量回到自动目录。项目根目录、`packages/` 以外的路径及通过符号链接／junction 绕出的路径都会被拒绝。不要在项目根目录直接运行 `npm pack`，该 npm 原生命令不会使用项目打包脚本的目录与保护规则。

`packages/releases/` 只保存对应 npm／GitHub Release 的原始包，不使用当前工作分支重新构建后替换。测试包即使仍显示已发布的版本号，其内容也可能与正式包不同；本地提交不会自动提升版本或发布。

此流程不修改版本、不创建标签、不发布 npm，也不覆盖项目根目录的正式包。测试包仅用于本地验收，不应替换同版本的已发布附件；安装方式见[使用与配置](usage.md#使用本地安装包)。

## 发布边界

完成修改后进行本地 Git 提交；普通提交与推送只保存或同步代码，不创建版本或触发 CI。只有维护者明确决定发布新版本，才更新版本、创建标签并正式发布 GitHub Release。可信发布绑定、CI 顺序、失败重跑与手动备用发布见[发布与验证](publishing.md)。
