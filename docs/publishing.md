# 发布到 npm 与 Koishi 插件市场

本项目是独立 npm 包，包名为 `koishi-plugin-codex-resets`，在 Koishi 市场显示的插件名为 `codex-resets`。当前版本号、Koishi peer dependency、服务依赖和公开发布配置都保存在根目录 `package.json`。

名称中的 `codex-resets` 对应数据源 `codex-resets.com`。发布前应确认包名、版本号和 Koishi 依赖声明符合[准入条件](https://koishi.chat/zh-CN/guide/develop/publish#准入条件)。

## 首次发布

在本项目目录通过 npm 官方注册表完成浏览器登录，然后发布：

```sh
npm login --auth-type=web --registry https://registry.npmjs.org/
npm whoami --registry https://registry.npmjs.org/
npm publish --access public --registry https://registry.npmjs.org/
```

登录和发布时如出现浏览器验证或双重验证，请由账号持有人完成。`prepublishOnly` 会运行构建和自动化测试，`prepack` 会构建实际分发文件。发布内容仅包含编译后的 `lib/`、`docs/`、README、许可证及 npm 清单，不包含本地依赖目录或测试工程。

## 验证发布结果

```sh
npm view koishi-plugin-codex-resets name version dist-tags --json --registry https://registry.npmjs.org/
```

确认注册表中版本和 `latest` 标签正确后，在 Koishi 插件市场搜索 `codex-resets`。符合规范的 npm 包会由市场索引收录；注册表发布成功与市场完成索引同步应分别确认。[Koishi 发布说明](https://koishi.chat/zh-CN/guide/develop/publish)

## 后续更新

修改代码后递增版本号，再发布新版本：

```sh
npm version patch --no-git-tag-version
npm publish --access public --registry https://registry.npmjs.org/
```

同一个包名和版本号不能重复发布。每次发布前完成本地 Git 提交；GitHub 推送只同步代码，CI 和后续发布按用户指令手动执行。[npm publish 文档](https://docs.npmjs.com/cli/v12/commands/npm-publish/)
