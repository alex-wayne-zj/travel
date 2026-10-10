# Travel 私人数据服务

单管理员与受邀朋友的 Rust / axum / SQLite 服务；没有公开注册、远程初始化、公共行程或数据导出接口。每位朋友有独立空间，管理员经 HTTP 也只能读取自己的旅程与模板。只监听 loopback，HTTPS 和静态前端由既有 Nginx 管理。数据存放在独立于构建产物的目录。

## 构建与本地检查

```sh
cargo fmt --check
cargo clippy -j 1 --all-targets -- -D warnings
cargo test -j 1
cargo build --release -j 1 --locked
python3 tests/runtime.py
```

工具链由 `rust-toolchain.toml` 固定，依赖由 `Cargo.lock` 固定。VPS 重型构建串行；开发运行不需要 Docker、Redis 或其他数据库。

## 配置与账号

环境变量：

| 变量 | 默认值 | 用途 |
|---|---|---|
| `TRAVEL_DB_PATH` | `./travel.db` | SQLite 路径；生产应使用持久数据目录 |
| `TRAVEL_BIND` | `127.0.0.1:8078` | 必须为 loopback 地址 |
| `TRAVEL_ORIGIN` | `https://localhost` | 精确 origin；生产必须显式设置，例如 `https://travel.example.com`，不含末尾斜杠 |
| `TRAVEL_SECURE_COOKIE` | `true` | 生产固定 true；本地 HTTP 开发可 false |

默认 origin 仅用于本机 HTTPS，不指向任何线上服务。本地 HTTP 开发同时设置 `TRAVEL_ORIGIN=http://127.0.0.1:5175` 与 `TRAVEL_SECURE_COOKIE=false`；生产在服务环境文件中显式设置真实 HTTPS origin，部署脚本从同一配置读取访问地址。

首次只在服务器本地初始化；密码文件 0600 或更严格、最大 4096 字节，trim 后密码至少 12 字符且最多 1024 字节。不要把密码放在命令参数或代码中。

```sh
TRAVEL_DB_PATH=/var/lib/travel/travel.db ./target/release/travel-backend init-admin --username admin --password-file /private/path/initial-password
TRAVEL_DB_PATH=/var/lib/travel/travel.db ./target/release/travel-backend
```

`init-admin` 拒绝覆盖已有账号。遗失密码可用同样参数执行 `reset-password`，会撤销管理员会话并解除管理员登录锁定（不影响朋友账号）；密码文件由管理员用后清理。正常修改密码通过已认证的 `/api/password`，校验旧密码，轮换当前会话并撤销该账号其他会话。

默认 cookie `__Host-travel_session` 为 host-only、Secure、HttpOnly、SameSite=Strict、Path=/。HTTP 开发使用 `travel_session`。会话随机 token 为 32 字节，只保存 SHA-256 摘要；7 天绝对过期、12 小时闲置过期，最多保留 20 个会话。Argon2id 使用库默认参数，单个密码验证/哈希并发，数据库操作及密码计算运行在 `spawn_blocking`，阻塞数据库任务最多 16 项，超额立即返回 429，不建立无限等待队列。

Nginx 必须覆盖 `X-Real-IP` 为 `$remote_addr`；后端只对 loopback peer 信任此头，不使用外部 X-Forwarded-For。所有修改请求，包括登录，必须提交精确 `Origin`；已认证修改另需 `X-CSRF-Token`。用户数据 API 全部认证，响应禁止缓存。错误 JSON 不包含数据库内部错误。

登录和旧密码验证共享账户与 IP 双计数；5 次失败锁 15 分钟，SQLite 保存并跨重启生效；未知用户名也验证同一账号密码哈希且使用同样错误。入口每 IP 每 60 秒最多 120 请求，计数 map 最多 2048 项、到期回收；认证计算过忙返回 429。请求限制 1 MiB。此为个人服务的请求/暴力破解限制，不能抵御网络流量 DDoS。

## 数据与版本

`GET /api/session` 返回 `{authenticated, username?, csrfToken?}`。所有 trip/template API 契约见上级项目说明与前端类型，JSON 字段 camelCase。`updatedAt` 为 Unix **秒**。行程 UUID、version 从 1 开始；保存/删除须带当前 version，过期版本返回 409，避免覆盖另一页面修改。

一条 SQLite JSON 记录对应一趟旅行，天数/事件嵌套保存。数据库包含单管理员账号、旅程、每个账号模板、会话、认证计数、朋友邀请账号 `invites` 及管理员一次性种子标记 `metadata`。旅程 `owner_id`、模板 `owner_id`、会话 `account_id` 指明独立空间；管理员 owner 固定为 `admin`，朋友 owner 是不可复用 UUID。所有读写 SQL 按 owner 过滤，跨账号返回 404，不接受客户端提供 owner。首次数据库自动导入德国双人示例与默认行李模板；删除全部旅程后重启不会复活示例。

`packing.baseItems/baseNotes` 保存创建时模板快照；不传 `baseItems` 的新建请求自动复制当前模板。更改共用模板只影响之后新旅程，旅行 `extraItems/checkedIds/hiddenBaseIds/notes` 独立保存。兼容没有快照的旧记录，但更新旧记录不会隐式替换它的模板。

边界：200 趟旅行，每趟连续日期最多 60 天，每天 40 活动，模板/旅行额外行李各 100 项；ID 唯一且最长 80 字符；合法 ISO 日期、时间、坐标和 slot/kind；来源 URL 限 HTTPS、最长 500 字符；备注 10000 字符以内。允许天内零事件作草稿。所有 SQL 值使用参数化查询。

## 迁移、备份与回滚

当前 schema 为 `PRAGMA user_version=2`。启动以 SQLite 事务将 schema 1 升级到 2：保留单管理员 users、现有旅程/会话，添加 owner/account 字段；将管理员模板迁移至 owner 主键。schema 0 新库经同一路径初始化。拒绝打开比本程序更新的 schema，防止降级覆盖。未来修改结构须先通过下面命令做一致性备份，再新增版本迁移并测试恢复，不手工改线上表。

```sh
TRAVEL_DB_PATH=/var/lib/travel/travel.db ./target/release/travel-backend backup --output /private/backups/travel-YYYYMMDD.db
```

备份使用 SQLite backup API，可在服务运行时得到一致性数据库，目标必须不存在且创建即 0600。backup 子命令不创建 App、不执行迁移或种子导入，能在启动 schema 2 服务前备份原 schema 1。不要仅复制运行中的 `.db`，因为提交数据可能在 WAL。备份包含私人计划和账号哈希，应放于受限目录并限制保留数量。

恢复：先停止本项目 systemd 服务，保留现有数据库及其 `-wal/-shm` 到受限隔离目录；将已验证备份恢复至 `TRAVEL_DB_PATH`，确认服务用户所有权与 0600，再启动匹配 schema 的 release。不要把旧数据库主文件与新 WAL 混用。代码回滚可替换上一份兼容 schema 的二进制；改变 schema 时应按迁移方案决定是否恢复数据备份。启动后验证 `/api/health`、登录、旅行读写与持久化。健康接口仅 `{ok:true}`，不泄露账号、路径或数据。


## 朋友独立账号

初始邀请名单仅为合成的停用占位：`enabled=false`、`hasCode=false`，数据库不存在默认邀请码。管理员可自行修改名单、设置邀请码后启用；朋友使用名字+邀请码登录。每个朋友首次成功登录，在单独事务中创建自己的德国十天样例和默认行李模板，并记录 `seeded=1`；日后删空计划不会重新出现样例，停用再启用仍保留原空间。朋友修改自己的旅行、模板和密码不影响管理员或其他朋友。

邀请码只输入不回显，不写日志、不在前端硬编码；数据库保存 Argon2id 哈希。至少 8 字符、最多 256 字节，禁止首尾空白/控制符，可使用多词易记组合。名字 1–80 字符，NFKC + Unicode lowercase + 合并空格生成唯一标准名，防止大小写/全角重复；显示名原样保留（trim）。最多 50 个邀请账号。

- `POST /api/invite-login {name,code}` 返回会话；公开接口不列出朋友名字。
- 会话 `{authenticated,role:'admin'|'friend',username,displayName,csrfToken}`；朋友与管理员使用相同私有安全 cookie。
- `GET /api/invites -> {invites:[{id,name,enabled,hasCode,version}]}` 仅管理员。
- `POST /api/invites {name,enabled,code?}` 返回 201 + Invite；启用前必须有 code。
- `PUT /api/invites/:id {name,enabled,code?,version}` 返回新版 Invite；不传 code 保留现有凭证，冲突 409。任何变更立即撤销此朋友会话。
- `DELETE /api/invites/:id {version}` 返回 204，撤销并删除凭证，保留旧 owner 的私人数据；同名重建使用新 UUID/新空间，不继承旧数据。日常暂停使用启用开关即可保留可恢复的账号空间。
- 朋友使用原有 trip/template CRUD 与 `/api/password {currentPassword,newPassword}`；新密码即其新邀请码，轮换自己的会话，管理员密码和其他朋友会话保持不变。朋友无邀请管理权限，返回 403。

朋友登录失败 5 次锁 15 分钟，按朋友账号和来源 IP 独立持久化；未知名字只计朋友 IP 锁，不触碰管理员账号或管理员 IP 登录锁。所有登录共享一个密码计算许可，避免多人哈希同时耗尽小 VPS 内存。

**升级与回滚边界：**原 schema 1 后端拒绝打开 schema 2；首轮升级后不能直接回退该二进制，必须拒绝旧代码回滚，保留用户新数据。可回滚至支持 schema 2 的已验证发布版本。不要通过覆盖旧数据库或降低 user_version 来强行回退；部署层在升级前用纯 backup 命令留存 schema 1 恢复点，需要真正数据恢复时必须另行确认。


## 按旅程准备地图

`GET /api/trips/:id/map-pack` 只查缓存，`POST`（body `{}`）准备资源；二者首先重新验证会话与旅程 owner，跨账号 404。POST 沿用 Origin/CSRF。输出为 `{overview:Pack|null,days:{[dayId]:Pack},missing:[{id,reason}]}`，Pack 仅有本机 `/map-packs/<64hex>.pmtiles` URL、bounds 与 maxZoom；不返回私人路线、名字或服务器路径。

固定 `/usr/bin/python3` 执行管理员配置的绝对路径 `TRAVEL_MAP_PACK_SCRIPT`（默认 `/opt/travel/map-pack.py`）。stdin 只含 day ID 与事件起终点坐标，移除标题、城市、时间、备注和来源 URL。脚本不可由服务用户修改。缓存 GET 最多 4 并发/10 秒，准备 POST 全局单任务/200 秒；后台监督任务持有许可到完成，客户端断开不能绕过并发上限。stdout/stderr 各限制 64 KiB，溢出/超时终止子进程；原始 stderr 不响应或记录，manifest 严格校验并拒绝外部 URL/未知字段。

Python 子工具还须确保 supervisor 被 SIGKILL 后固定 Go CLI 也终止（生产脚本使用 Linux PDEATHSIG），否则父进程锁释放可能留下孤儿下载。实际缓存容量、下载配额、PMTiles 来源/CLI 校验及静态 Range 由地图脚本和 Nginx 配置管理。
