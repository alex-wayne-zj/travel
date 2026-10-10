# 旅途 Travel

私人旅行规划应用。React + TypeScript + Vite、Rust Axum、SQLite、systemd 与 Nginx HTTPS；不使用 Docker 或独立数据库服务。账号、行程和部署配置由使用者自行管理。

日程可安排早餐、上午、午餐、下午、晚餐、交通与住宿；每项可独立标记为备选。同一时段支持多个项目，主选与备选均可横向滚动。推荐词、地图、住宿与交通联动；可展开旅途历史，创建和编辑不同旅程，地图选点，按旅途记录行李与提醒。

基础行李清单与提醒在创建旅途时复制成快照，共用模板的改动只影响新旅程。当前旅途可添加补充物品、隐藏本次不带的基础物品。勾选与编辑后点击保存；失败/版本冲突保留草稿，登录过期可以原地重新认证。

国家单选自动绑定所示城市的当地时区；多国或“其他”使用手选东／西固定时区。美国、加拿大、澳大利亚、印度尼西亚等跨时区国家默认绑定纽约、多伦多、悉尼、雅加达，已有旅程的历史时区不在打开时自动改写。

## 德国虚拟示例

仓库包含十天德国虚拟示例：法兰克福→海德堡→慕尼黑→柏林→法兰克福返回。景点、餐厅、酒店是真实公开地点；示例日期、票务时刻与住宿安排均为合成资料，不表示任何人的真实行程，没有查询可售库存或预订。每天四个主选和三项备选，具体交通与住宿时间按行程时区显示。`src/itinerary.json` 同时用于后端新账号的示例导入和自动化测试。

地图使用 MapLibre GL、OpenFreeMap 公共矢量底图与可选 Protomaps 区域包，无需前端 API Key；地图保留来源与必要版权链接。地图需要 WebGL，网络不可用时日程仍可浏览。下载生成轻量离线 HTML，仅包含每天的活动（含备选）、交通住宿详情与行李提醒，不制作或下载地图。

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
