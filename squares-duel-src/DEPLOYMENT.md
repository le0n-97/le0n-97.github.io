# 开发与发布

维护仓库：`le0n-97/le0n-97.github.io`，源码目录：`squares-duel-src/`，主分支：`main`。

## 日常开发

```text
git clone https://github.com/le0n-97/le0n-97.github.io.git
cd le0n-97.github.io/squares-duel-src
npm run install:ci
npm test
npm run typecheck
npm run dev
```

使用 Node.js 24。修改后正常提交、push 或创建 pull request；以后以 GitHub 的提交为准。完整应用、数据库结构、迁移、词库、许可证和测试都在该目录内。账号、登录凭证和线上数据库内容不进入代码仓库。

## GitHub Pages

`.github/workflows/squares-duel.yml` 在源码变更时执行测试、类型检查、后端构建和前端构建。PR 只验证；`main` 检查通过后生成网站，更新 `squares-duel/` 中的生成文件并发布 GitHub Pages。

发布前检查 `main` 仍指向本次验证的源码提交；如果已有更新提交，则由新一轮检查发布，避免旧构建覆盖新修改。个人主页和其他公开目录从同一个提交保留。可以在 Actions 页面手动运行该工作流。无需配置个人访问令牌。

网址保持为 https://le0n-97.github.io/squares-duel/ 。`squares-duel/deployment.json` 记录对应源码提交。

## 后端与数据库

GitHub 保存完整后端源码，并在 CI 中编译。GitHub Pages 负责网页，现有 API、账号和 Rating 数据库继续运行在 Sites：

- 项目 ID：`appgprj_6ad0c266c7d481918d80df8286bcbe8c`
- API：https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site/api/
- 原站非 API 页面保持关闭。

当前 Sites 发布通过已连接的 Sites 工具完成。GitHub 的 `GITHUB_TOKEN` 不是 Sites 的部署凭证，因此 CI 不会自动替换线上后端或数据库。

后端改动上线流程：

1. 先在 GitHub 提交并验证改动，记录待部署的完整提交 SHA。
2. 从该提交取出 `squares-duel-src/`，验证依赖、测试和生产构建。
3. 使用既有 Sites 项目的源码发布助手打开部署镜像，将该 GitHub 提交的源码同步进去；保留镜像的 Git 信息、本地运行状态和部署凭证隔离。
4. 在部署镜像中按 Sites 工作流构建、推送、打包、保存版本并发布。托管服务会应用新增迁移。
5. 检查线上 API 和账号功能，记录该 Sites 版本对应的 GitHub SHA。后续开发继续在 GitHub 源码目录进行。

不要创建替代数据库、回滚已应用迁移、上传 `.wrangler` 数据或把短期部署凭证写入 GitHub。旧的 Sites 源码仓库只用于发布镜像。
