# le0n-97.github.io

个人主页与 Squares Duel 游戏。

- [游戏网址](https://le0n-97.github.io/squares-duel/)
- [Squares Duel 完整源码与开发说明](squares-duel-src/README.md)
- [自动检查与发布](../../actions/workflows/squares-duel.yml)

`squares-duel-src/` 是游戏的唯一维护源，包含前端、后端、数据库结构和测试。`squares-duel/` 是自动生成的网页文件，请修改源码后提交，不要手改生成文件。其他目录和首页保留原有个人网站内容。

源码修改通过 pull request 或提交到 `main` 开发。GitHub Actions 会检查测试、类型和前后端构建，检查通过后自动更新游戏网页。后端继续运行在原有托管服务，部署方式见 [DEPLOYMENT.md](squares-duel-src/DEPLOYMENT.md)。
