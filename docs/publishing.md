# 发布到 npm 与 Koishi 插件市场

包名为 `koishi-plugin-codex-resets`，Koishi 市场中的插件名为 `codex-resets`。GitHub 仓库保持私有，npm 包公开。版本号、仓库地址与 Koishi 依赖声明以根目录 `package.json` 为准。

## 日常开发与发版边界

日常修改、测试、本地提交和普通推送仅同步代码，不自动修改版本号、不创建 Git 标签或 GitHub Release，也不触发 CI。只有维护者明确决定发布新版本时，才修改版本并发布正式 Release。

工作流 `.github/workflows/publish.yml` 只响应 `release: published`。草稿、预发布、普通 push、PR 和单独推送标签均不会发布 npm。创建 Release 是一次正式的 npm 发布授权；将预发布转为正式发布也会触发该流程。工作流不会自行提交、增加版本号或创建 Release。

## 一次性配置 npm 可信发布

使用 npm Trusted Publishing（OIDC），绑定以下内容：

| 项目 | 值 |
| --- | --- |
| npm 包 | `koishi-plugin-codex-resets` |
| GitHub 用户 | `HuangArmagh` |
| GitHub 仓库 | `koishi-plugin-codex-resets` |
| 工作流文件名 | `publish.yml` |
| Environment | 留空，与当前工作流一致 |
| 直接发布 | 允许 `npm publish` |

可以在 npm 包设置的 Trusted Publisher 中配置，也可以使用当前 npm CLI：

```sh
npm trust github koishi-plugin-codex-resets --repo HuangArmagh/koishi-plugin-codex-resets --file publish.yml --allow-publish --registry https://registry.npmjs.org/
```

账号持有人完成要求的安全验证。新建授权必须在 **2 天内完成首次成功发布**；否则授权会过期，需要重新绑定。保存配置本身不等于已经完成端到端验证。后续发布由 GitHub 官方托管 runner 获取短期凭证，无需保存长期 npm Token。

工作流使用 Node.js 24、npm 12.2.1，GitHub Actions 固定到已核对的提交。构建任务仅有代码读取权限；发布任务在构建成功后才启动，拥有 OIDC 与上传 Release 附件所需权限。依赖安装和测试在构建任务内运行，发布任务不安装本项目依赖。

私有仓库的发布不生成 provenance，工作流明确关闭该选项。`package.json` 中的 `repository.url` 必须与绑定的 GitHub 仓库匹配；该仓库地址随公开 npm 清单发布，仓库代码的访问权限仍保持私有。[npm 可信发布说明](https://docs.npmjs.com/trusted-publishers/)

## 发布一个新版本

1. 明确选择尚未使用的正式版本号，更新 `package.json` 和锁文件。例如 `npm version 0.5.2 --no-git-tag-version`；此命令只在决定发版时运行。
2. 完成修改、运行 `npm run check`，本地提交并按指令推送。
3. 在该提交上创建对应标签，例如 `v0.5.2`，推送标签，并正式发布 GitHub Release。标签必须与包版本完全一致。
4. 查看 GitHub Actions 中的 `Publish npm package`。工作流将按下述顺序执行。

不要重复发布已经存在的版本。现有 Release 的源代码和安装包均以其标签为准；工作分支可以继续提交配置与功能改动，只有下一次明确发版才递增版本号。

## 自动执行顺序

1. 校验仓库、正式 Release 状态、标签、包版本、锁文件以及检出的提交。
2. 安装锁定依赖，执行构建及完整回归测试。若以后拆分 Fast / Full，必须先等待同一提交的 Fast 通过，再启动 Full。
3. 只打包一次，检查包内文件白名单、入口文件、清单一致性，以及疑似凭证、邮箱和本地用户路径。拒绝额外文件、链接文件与不符合预期的归档结构。
4. 将校验后的安装包交给后续发布任务，重新核对 SHA-256 和 npm 版本状态。
5. 仅当该版本尚未发布时，以 OIDC 执行 `npm publish`。发布使用已验证的 `.tgz`，不重复构建或执行包脚本。
6. 每 30 秒查询一次官方注册表，最多等待约 10 分钟，核对版本、`latest`、SHA-1 和 SHA-512。限流、访问错误或校验冲突会停止流程，不自动提高频率。
7. 把同一个 `.tgz` 上传到当前 GitHub Release，再核对附件 SHA-256。

检查失败会阻止后续步骤。工作流串行发布，不会取消已经运行中的发布。它不自动改写 `latest`、覆盖已发布版本或替换不同内容的同名附件。发布流程使用普通可补充附件的 Release；如果仓库启用了不可变 Release，须在正式发布前安排好附件，不能依赖发布后的上传步骤。

## 失败后重跑

- 在 GitHub Actions 中重跑该次 Release 工作流，不创建新版本来绕过失败。
- 如果 npm 已存在同版本，只有安装包校验值一致才跳过发布并继续验证和补传附件；内容不同则停止。
- 如果 `latest` 已指向更新版本，拒绝回退。
- 同名 Release 附件校验值相同时保留；不同则停止，交由维护者检查，不自动覆盖。
- npm 已接收包但索引仍在处理时，等待注册表完成处理。已发布包不可自动回滚或以相同版本重发。
- OIDC 的第一次实际发布成功，才证明 npm 授权、GitHub 权限及流水线端到端可用；本地模拟测试不会替代这一步。

## 本地验证与手动备用发布

```sh
npm ci
npm run check
```

修改 GitHub 工作流时，提交前还需运行 `actionlint .github/workflows/publish.yml`，检查表达式和上下文。仅能解析 YAML 不代表 GitHub 能执行该工作流。

本地验证打包时，将环境变量 `RELEASE_DIR` 设置为一个新的临时目录，再运行 `npm run release:pack`。该命令只构建归档并检查内容，不修改版本、不发布网络内容。应先运行构建／测试；已有正式安装包不覆盖。

只有维护者明确要求手动发布时，才使用下面的备用流程：

```sh
npm login --auth-type=web --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/
npm publish --access public --registry https://registry.npmjs.org/
```

手动发布目录时，`prepublishOnly` 执行构建和测试，`prepack` 构建分发文件。仅在指定新版本、完成本地提交并检查安装包之后发布。CI 入口不接受任意本地目录或用户提供的外部安装包。

## 查看发布结果

```sh
npm view koishi-plugin-codex-resets name version dist-tags --json --registry https://registry.npmjs.org/
```

Koishi 插件市场独立同步符合准入要求的 npm 包；npm 发布成功与市场索引同步分别确认。同步后在控制台搜索 `codex-resets` 安装或更新。[Koishi 发布说明](https://koishi.chat/zh-CN/guide/develop/publish)
