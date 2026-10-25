# 发布约定

- 本地提交仅保存当前改动，不自动修改版本号、不创建 Git 标签或 GitHub Release。
- 普通代码推送不触发 CI、npm 发布或版本生成。只有用户明确要求发布新版本时，才更新版本并创建正式 Release。
- `.github/workflows/publish.yml` 只响应正式 Release 的 `published` 事件；构建、测试及包检查通过后才发布 npm。预发布和草稿不发布。
- 保持版本、锁文件和 Release 标签一致。已发布版本及其安装包不可重新生成后覆盖。
- 所有安装包统一放在项目内 `packages/`：原始正式包放 `packages/releases/`；`npm run release:pack` 默认在 `packages/test/` 新建独立目录；CI 使用 `packages/ci/`。不得把安装包放在项目根目录或系统临时目录，不得覆盖已有同名包。`packages/` 不提交 Git，也不进入 npm 包。
- 保留完整回归测试。若以后拆分 Fast / Full，必须先等同一提交的 Fast 通过，再运行 Full。
- 修改工作流后，提交前使用 actionlint 检查 GitHub 表达式与上下文；YAML 解析通过不能代替工作流语义检查。
- 完成修改后进行本地 Git 提交。不得为纯查询或外部配置操作创建空提交。
- 网站请求串行并使用缓存；连续检查同一站点至少间隔 5 秒，遵守更长的 Retry-After，遇到限流或拦截停止重试。
