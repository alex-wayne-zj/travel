# 旅途 Travel

私人旅行规划应用。React + TypeScript + Vite、Rust Axum、SQLite、systemd 与 Nginx HTTPS；不使用 Docker 或独立数据库服务。账号、行程和部署配置由使用者自行管理。

日程可安排早餐、上午、午餐、下午、晚餐、交通与住宿；每项可独立标记为备选。同一时段支持多个项目，主选与备选均可横向滚动。推荐词、地图、住宿与交通联动；可展开旅途历史，创建和编辑不同旅程，地图选点，按旅途记录行李与提醒。

基础行李清单与提醒在创建旅途时复制成快照，共用模板的改动只影响新旅程。当前旅途可添加补充物品、隐藏本次不带的基础物品。勾选与编辑后点击保存；失败/版本冲突保留草稿，登录过期可以原地重新认证。

国家单选自动绑定所示城市的当地时区；多国或“其他”使用手选东／西固定时区。美国、加拿大、澳大利亚、印度尼西亚等跨时区国家默认绑定纽约、多伦多、悉尼、雅加达，已有旅程的历史时区不在打开时自动改写。

## 德国虚拟示例

仓库包含十天德国虚拟示例：法兰克福→海德堡→慕尼黑→柏林→法兰克福返回。景点、餐厅、酒店是真实公开地点；示例日期、票务时刻与住宿安排均为合成资料，不表示任何人的真实行程，没有查询可售库存或预订。每天四个主选和三项备选，具体交通与住宿时间按行程时区显示。`src/itinerary.json` 同时用于后端新账号的示例导入和自动化测试。

## 地图与天气

地图使用 MapLibre GL、OpenFreeMap 公共矢量底图与可选 Protomaps 区域包，无需前端 API Key；地图保留来源与必要版权链接。地图需要 WebGL，网络不可用时日程仍可浏览。

选点地图支持粘贴苹果地图或高德地图的地点分享链接及分享文字，解析后预览落点，确认后才填入；新活动的空白名称和参考链接会一并补入，住宿地址和交通终点名称也只补空字段。已填写内容不会覆盖。支持 Apple `/place?coordinate=`、旧版地点 `ll`、高德 marker/单点 markers/lat-lon、`wb.amap.com/?p=` 和两家的短链接；视野中心、搜索中心、路线或只有 POI ID 的链接不冒充地点，无法解析时保留手动选点。高德坐标近似转为现有底图的 WGS84；经东方明珠真实样例对照的 Apple 大陆 H-place 链接按高德坐标处理，其他 Apple 链接不盲目转换，可通过“校正国内地图偏移”切换并核对落点。坐标校正不适合作为工程测量依据。

短链通过已登录且带 CSRF 的 `POST /api/map-links/resolve` 展开，不需 API Key；只请求明确允许的地图域名，逐跳校验、固定公网 DNS 地址、禁用代理与环境 curl 配置，限制总时长 12 秒、4 次跳转、256 KiB 响应体、16 KiB 响应头、2 并发和每进程每分钟 30 次/每日 300 次请求（重启重置）。不会将本应用 Cookie、账户或凭证发给地图服务，不读取地图收藏或抓取商家详情。浏览器回归检查：`node scripts/map-import-check.mjs`（本地 Vite 默认端口 5198）；解析单测包含在 `npm test`，后端网络样例为显式运行的 ignored 测试。

每日交通与住宿区域显示 Open-Meteo 天气卡片（地点、天气类别、最低最高温、最高降水概率），无分时预报或弹出提醒。按主要活动区域取点，无活动时取住宿，再回退到交通抵达点；按预报地点当地日期匹配。历史日期和超出约 16 天预报范围显示相应状态，缺失降水概率显示“暂无”。

天气由已登录且拥有该旅程的用户访问后端 `/api/trips/{id}/weather/{day_id}` 获取；服务器需有 `curl` 和 HTTPS 出站访问能力，无需 API Key 或计费账户。仅坐标发送至 Open-Meteo。缓存一小时、失败冷却两分钟、旧缓存最多保留 24 小时并注明，内存缓存最多 128 个地点；缓存命中不等待其他地点的上游请求，同地点并发请求复用结果；每进程最多每分钟 10 次、每日 1000 次上游请求（UTC 日界，重启重置），不新增数据库表。天气加载失败不影响日程，离线导出不包含天气。免费 API 仅限非商用并须保留来源链接。

下载生成轻量离线 HTML，仅包含每天的活动（含备选）、交通住宿详情与行李提醒，不制作或下载地图。

## 开发与检查

依赖由 package-lock.json / backend/Cargo.lock 锁定，Rust 工具链由 backend/rust-toolchain.toml 固定。前端开发代理 `/api` 到本机 8078。

```sh
npm ci
TRAVEL_DB_PATH=/private/dev/travel.db TRAVEL_ORIGIN=http://127.0.0.1:5175 TRAVEL_SECURE_COOKIE=false backend/target/release/travel-backend
npm run dev -- --port 5175
npm test
npm run build
```

首次使用前按 [backend/README.md](backend/README.md) 初始化管理员。生产密码只保存在服务器私有文件，账号可在页面设置中修改密码。无公开注册；连续五次错误登录锁十五分钟，锁定跨重启持久化；Secure/HttpOnly/SameSite 会话，精确 Origin、CSRF、参数化 SQL、请求边界、乐观版本防覆盖。

浏览器验收使用现有 Chromium，可设置 `TRAVEL_TEST_URL` 与 `TRAVEL_TEST_PASSWORD_FILE`；只对临时测试数据库运行有写入的 app-check：

```sh
TRAVEL_TEST_PASSWORD_FILE=/private/dev/password node scripts/browser-check.mjs
TRAVEL_TEST_PASSWORD_FILE=/private/dev/password node scripts/app-check.mjs
```

核心测试覆盖日期四时段/备选、九晚住宿、票务、路线/空日；后端 tests/runtime.py 验真实 HTTP/CLI、认证、锁定、持久化、备份；浏览器覆盖十天×三个视口、创建编辑、草稿、重新登录、行李隔离、模板快照、地图故障恢复及手机退出。产物在 `.artifacts/`。不宣称手机实机或 Safari 验证。

## 部署与恢复

后端只监听本机，专用非 root 用户运行；SQLite 与配置分离，代码回滚不覆盖历史数据。通用配置模板位于 `deploy/*.example`：复制为同名配置后填写自己的域名、证书和目录，并在服务器配置 `TRAVEL_ORIGIN`。实际配置先 `nginx -t` 再 reload。具体服务器发布记录不进入仓库。

```sh
cargo build --release -j 1 --locked --manifest-path backend/Cargo.toml
python3 scripts/deploy.py
python3 scripts/deploy.py --rollback
```

部署会一致性备份数据库，验证完整性，切换前后端版本并验证实际 HTTPS HTML/assets/API；失败恢复前版。保留两套发布、三份自动备份。登录/API 限速与连接限制用于缓解应用滥用，不能保证抵御网络链路型 DDoS。

提交前的隐私与配置边界见 [docs/PUBLICATION.md](docs/PUBLICATION.md)。仅在临时测试数据库上运行有写入的验收脚本；部署前先按自身环境检查发布脚本的配置。
