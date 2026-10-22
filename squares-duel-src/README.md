# Squares Duel · 双队拼词对决

完整源码现维护在 [le0n-97/le0n-97.github.io 的 squares-duel-src 目录](https://github.com/le0n-97/le0n-97.github.io/tree/main/squares-duel-src)。这里包含前后端、数据库结构、迁移、词库与测试；`main` 的源码变更通过 GitHub Actions 检查并发布前端。具体流程见 [DEPLOYMENT.md](DEPLOYMENT.md)。

首次开发请克隆该仓库，进入 `squares-duel-src/`，使用 Node.js 24 运行 `npm run install:ci`。此目录是唯一维护源；旧的本地 Sites 副本仅作为后端部署镜像。

玩家加入同一个房间的橙队或蓝队，共用一张 4×4 英文字母棋盘，两队人数可以不同。也可以选择旁观。按住鼠标或手指拖动连字，松开自动提交并清空选择，不提供直接输入单词的入口。

- 字母可以横、竖、斜相邻连接，同一单词不能重复使用一个格子，至少 4 个字母。
- 普通词每个字母 1 分；附加词（Bonus）不论长度，每个词 +1 分。
- 单词归最先成功提交的玩家，双方都不能重复领取。
- 队伍总分为队员得分之和，胜负按两队总分判定，同分平局。同一单词在整个房间只能计分一次，包括同队成员之间。
- 加入房间后不会自动开局。准备室中可自行换队、参赛或旁观，棋盘暂不公开；两队各至少一名队员后，由房主点击开始。单房间最多 64 名成员（含旁观者）。
- 开始后固定参赛队伍，新成员仍可旁观。旁观者能看棋盘、比分、已找到的词及赛后复盘，不能提交单词或 Commit。房主也可以选择旁观并负责开局。
- 每找到一个新词（含附加词），三分钟无新词倒计时重置。
- 所有普通计分词被双方合计找完后立即结算；附加词无需全部找到。
- 创建房间和再来一局都会随机选择一个 8–10 字母普通词，沿随机相邻路径放入棋盘，其余字母随机生成，再求出完整普通词和附加词表。每张棋盘至少有 1 个 8+、2 个 7+、3 个 6+ 字母普通词。可选择少量（30–40 个）、适中（41–55 个）、丰富（56–70 个）普通计分词；不限档在 30–70 个范围生成。只接受同时符合词量和长词要求的完整棋盘，不裁剪词表，也不回退到固定题库。
- 随机生成会避开原有 262 张固定棋盘及近期棋盘的旋转、镜像形式；浏览器记录最近 32 张，房间保留最近 64 张。旧房间当前对局仍用原来的棋盘和词表，双方再来一局后切换为新生成。
- 点击 Commit 即不可撤回地交卷，交卷的队员不能继续找词；只有整支队伍全员 Commit 后才触发固定 60 秒结算，新词不能延长期限。两队全员 Commit、无新词满三分钟或所有普通计分词找完时可更早结算。
- 结算后由房主点击再来一局，回到新一轮准备室，重新分队后仍需房主手动开始。刷新当前标签页可恢复身份。
- 结算后显示本局完整计分词和附加词表，以队伍颜色和找到者姓名标记归属。点击单词可在原棋盘查看固定标准连法（canonical），含连线和字母顺序；对局进行中不公开答案，下一局准备时隐藏上一局词表。
- 自己或对方找到新词、进行 Commit 时，页面上方居中弹出提示；新提示立即替换旧提示。
- 按长度显示普通计分词的已找、总数和剩余数量；双方合计找到 40% 的普通计分词后，在棋盘每格显示剩余普通词的标准连法从该格开始的数量。每词只计一次，Bonus 不计入提示进度和起点数量。
- 从开局起，不再出现在任何剩余普通词标准连法中的格子显示为灰色，与原版相同。灰色是视觉提示，仍可划选 Bonus 或其他合法连法。棋盘上方以大号倒计时显示当前最早结算期限。
- 棋盘可顺时针旋转，字母保持正立；旋转只影响自己的视角，选词、拖动和复盘路线保持对应。
- 提交请求按输入顺序处理，等待服务器回复时仍可继续选词；旧请求回复不会清空下一次选择。Commit 排在已提交的单词之后处理。
- 聊天只在准备室显示并开放读写，参赛者和旁观者都可以发言；比赛中和结算后隐藏并关闭聊天。房主准备下一局后会再次开放，保留同房间近期消息。服务器保留最近 200 条；每条最多 300 个字符，每位成员每秒最多发送一条。

新生成棋盘使用 SCOWL 英语词库，普通词和较生僻的 Bonus 词分开计分，收词范围与原站可能不同；词库来源与许可证随站点保存。旧的 262 张原版棋盘仅用于兼容旧房间。来源和规则核对记录见 [DATA_SOURCES.md](DATA_SOURCES.md)。运行时不依赖原站或外部词典接口；对局中仅提供汇总词数提示，完整答案仅在结算后公开。

## 本地运行

需要 Node.js 22.13+ 和 npm。在此目录执行：

```powershell
npm ci
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_great_taskmaster.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_game_records.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0002_room_chat.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0003_lethal_micromax.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0004_youthful_expediter.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0005_mute_bloodstorm.sql
npm run dev
```

首次运行执行数据库命令即可，不要重复执行同一迁移。开发地址默认是 `http://127.0.0.1:5173`。用多个独立标签页分别创建、加入队伍或旁观，也可以部署后将邀请链接交给朋友。

开发预览用 `npm run dev`。生产构建的旧站页面已关闭；`npm start` 可验证其 API 和关闭页面。开发和生产预览共享本地 D1 数据。托管部署会应用 `drizzle/` 下的迁移。

## 本地对局记录后台（仅本地开放）

在项目目录运行 `npm run admin`，打开 `http://127.0.0.1:5173/admin`，结束查看后可在终端按 Ctrl+C 停止。该命令只绑定本机。可按房间码或玩家姓名搜索已结束的对局，查看每局双方得分、胜负、结束原因、棋盘、找词和 Commit 时间线，以及带玩家颜色和标准连法的完整词表。后台没有前台入口；记录接口同时要求开发模式和本机地址，生产构建始终返回 404。逐局归档也只在本地开发模式启用，未导入或启用线上对局记录。

每局结束时，当前房间与独立记录在同一数据库事务内保存。“再来一局”不会覆盖旧记录，并发抢词或重复结算不会产生重复或未成功写入的结果。记录只保存复盘所需字段，不包含玩家身份凭证。后台读取会补录旧数据库仍保留的已结束对局，并结算已超时的当前对局；旧版中早已被重赛覆盖的轮次无法恢复。每次最多整理 100 条旧记录，页面会在需要时提示继续刷新。

已有本地数据库只需按顺序执行尚未应用的迁移；本工作区已应用 `0001_game_records.sql` 和 `0002_room_chat.sql`。未来若需要线上后台，应先增加管理员身份校验，再开放记录接口，不能仅靠隐藏入口。

## 验证

```powershell
node scripts/test-game.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

开发服务器运行时，还可执行 `npm run test:smoke`，通过真实 HTTP 和本地数据库验证创建、加入、抢词、交卷和再来一局。

本地记录后台可执行 `npm run test:records`，检查随机棋盘的双人计分、两局独立归档、重赛保留、完整复盘、搜索分页和本机访问限制。此检查仅允许本机地址，创建两局测试记录。

`node scripts/smoke-chat.mjs` 验证本机准备室聊天、增量同步、重复请求去重、旁观者聊天、房间隔离和开局后的聊天关闭。`node scripts/smoke-teams.mjs` 验证不等人数分队、房主手动开局、旁观权限、整队 Commit 与重赛回准备室。

服务端使用版本条件更新保证每个房间的抢词、加入、Commit 和再来一局操作原子化。玩家身份凭证只发给本人，数据库保存其 SHA-256 摘要。计分、词库校验和超时判定都在服务器执行；浏览器倒计时只用于显示。

## 账号

支持独立的用户名和密码注册、登录、退出及修改密码。创建房间、加入队伍、旁观和准备室聊天都必须登录；游客模式已关闭，旧游客凭证失效。账号名用作参赛名字；同一账号在同一房间只有一个身份，换设备登录后可用房间码恢复原有队伍、得分及交卷状态。旧游客身份不会自动绑定到账户。

密码使用独立随机盐及慢速密码派生算法保存，登录凭证仅保存摘要。修改密码会撤销所有旧登录；退出会撤销当前登录。账号数据存储在服务端，不进入 GitHub Pages 发布文件。登录状态会保存在当前浏览器；不提供邮箱或手机号找回密码，请妥善保存密码。

密码长度为 5–128 个字符，原有密码仍可使用。账号窗口仅通过右上角 × 关闭，点击背景、按 Esc、登录或注册成功都保留窗口。连接失败时保留输入；登录遇到短暂断线会自动重试一次，注册回包丢失时先用同一组凭证确认账号是否已经创建，避免重复注册。登录和注册使用不携带会话头的简单跨域请求，减少一次预检；服务端仍检查请求来源并保留原有频率限制。

## 团队 Rating

每个账号初始 Rating 为 1000。开局时锁定参赛队员、队伍和当时的 Rating，按双方实际得分占比结算；比赛本身的胜负和积分规则保持原样。旁观者不参与调分；双方零分的对局不调分，也不增加 Rating 对局数。上线前已进行的旧对局没有开局快照，不补算 Rating。

模型 `team-share-v1` 将每位队员的 Rating 换算为实力 `10^(Rating/400)`，将队伍所有人的实力相加，再归一化得到预计得分占比。因此同水平 1 对 2 的预计占比分别为 1/3、2/3；两边各有几人都会被计入，不能只靠平均 Rating 忽略人数优势。新手与高手混合组队也会按每个人的实力合计。

橙队本局调分总量为 `32 × (实际得分占比 − 预计得分占比)`，蓝队取相反数；每队的总调分均分给本队参赛者。因此少人一方打出超出预期的得分占比，即使总分小负也可能加 Rating；多人一方仅小胜也可能扣分。比如三个同水平玩家打 1 对 2，得分为 40:60，单人加约 2.13，另一队每人扣约 1.07。队友按相同团队表现调分，不按个人抢到的词数分配。

数据库以千分之一 Rating 为单位保存，整数余数固定分配，保持整场精确零和。开局后在其他房间完成的调分会累加，避免后一次结算覆盖前一次。房间结算、唯一局号凭据、个人调分记录和账号更新使用同一数据库事务，重复轮询、重复交卷及并发结算不会重复调分。线上只保存 Rating 所需的结算摘要和调分凭据，完整复盘记录后台仍仅在本地开放。

账号窗口显示当前 Rating 和已计分对局数；准备室及对局里显示队员开局 Rating 和队伍预计占比；赛后显示实际占比与每个人的本局变化。赛后账号 Rating 重新从服务端获取，不用开局 Rating 加本局变化来覆盖其他房间已经产生的变动。

顶部「排行榜」可查看全站 Rating 排名、账号名及已计分局数，并单独显示自己的名次。完成至少一局计分对局后上榜，旁观和双方零分的对局不满足上榜条件。榜单使用服务端当前 Rating（保留千分之一精度）降序排列，精确同分并列，下一名跳过对应人数；同分账号按用户名排序以保持翻页稳定。可以刷新榜单、翻页或直接定位自己的位置，打开榜单不会离开正在进行的房间。

`GET /api/leaderboard?offset=0&limit=20` 需要有效账号登录，默认每页 20 人，最多 50 人。一次数据库快照返回当前页、总上榜人数及本人名次，结果不缓存；只公开用户名、Rating、已计分局数和名次，不公开账号标识、登录凭证或完整对局记录。

## GitHub Pages 游戏网址

游戏唯一前台网址为 `https://le0n-97.github.io/squares-duel/`。原网站的游戏页面已关闭，生产环境非 API 路径返回 HTTP 410 和新网址入口；其后台仍为新前台提供游戏、聊天、账号及数据库服务。GitHub Pages 是静态托管，不能承载当前数据库和服务端计分，参见 [GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)。本地开发页面仍可使用。

```powershell
npm run build:pages
node scripts/prepare-github-pages.mjs
```

默认页面路径为 `/squares-duel/`，游戏接口为 `https://squares-duel-oct15.sacred-rhea-9950.chatgpt.site`。`PAGES_BASE`、`SQUARES_API_ORIGIN` 可用于其他部署或本地验证；正式导出脚本会校验默认配置、公开文件清单及服务端内容隔离，并在 `outputs/github-pages/` 下创建一个全新的发布目录。GitHub Actions 从本目录构建，自动将网页更新到仓库的 `squares-duel/` 目录并发布，保留个人主页和其他目录。源码与网页构建分目录维护；数据库内容和本地运行状态继续排除在 Git 之外。

服务端仅为精确来源 `https://le0n-97.github.io` 增加跨域支持，仍保留房间身份认证与服务器计分。预检不访问数据库，其他跨域来源被拒绝。本地对局记录接口不开放跨域，生产环境始终拒绝访问。

## 项目结构

- `app/page.tsx`、`app/globals.css`：对战界面。
- `app/api/game/route.ts`：房间和对战接口。
- `components/leaderboard.tsx`、`app/api/leaderboard/route.ts`、`lib/leaderboard.ts`：Rating 排行榜及只读查询。
- `app/admin/`、`app/api/admin/records/route.ts`、`lib/game-records.ts`、`lib/records-admin.ts`：仅本地使用的记录后台与逐局归档。
- `lib/game.ts`、`lib/word-routes.ts`：游戏规则、标准连法、格子提示与结算。
- `lib/board-generator.ts`、`lib/dictionary-data.ts`：随机布局、完整词表求解与固定版本词库，仅服务端引用。
- `lib/puzzles.ts`：仅供旧房间继续使用的历史棋盘及词表。
- `db/schema.ts`、`drizzle/`：数据库定义及迁移。
- `tests/`、`scripts/test-game.mjs`：规则和接口并发测试。
