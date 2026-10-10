# travel 地图方案调研（2026-10-09）

建议继续使用 OpenFreeMap 在线底图、Protomaps 区域包用于离线。这套组合无需注册新账号或新增付费服务，兼容现有 MapLibre、小 VPS 和下载流程。需要地址搜索、路线规划时，再优先考虑 Geoapify；仅为换底图引入新服务收益有限。

## 方案比较

| 方案 | 免费条件 | 细节与准确性 | 速度与本项目成本 | 下载适用性 |
| --- | --- | --- | --- | --- |
| OpenFreeMap（当前在线） | 官方公共实例无请求/浏览量上限、无 Key，可商用；无 SLA | OSM 数据、OpenMapTiles 矢量图。覆盖与更新质量取决于当地 OSM | 现有代码可直接使用，无新增常驻服务；实际速度取决于用户网络 | 官方提供每周全球 MBTiles/Btrfs 下载，但不适合本 VPS 装全球图。公共服务条款限制未经许可的自动化采集，继续仅用于在线浏览 |
| Protomaps + PMTiles（当前离线） | 开放数据；按区域复制到自有服务器仍有流量/存储成本 | OSM 基础地图、每日构建；细节由提取缩放级别和样式决定 | 静态文件支持 HTTP Range，不需瓦片服务；首次提取比已缓存浏览慢 | 最适合本项目：官方 CLI 支持区域提取。不要长期热链全球源作为在线底图 |
| Geoapify | 3,000 credits/天，最多 5 req/s，无需信用卡，需 Key/署名 | 提供底图、地理编码、POI 与路线等不同 API；底图更换不保证 POI 更准确 | 可兼容 MapLibre；增加外部配置与额度监控。无 Key，未实测其延迟 | 有静态地图 API：请求、瓦片、标记分别计费，不能把 3,000 credits 当成 3,000 张图。离线存储/再分发需另核对条款 |
| MapTiler Cloud | Free 适用于个人、非商业或原型；5k sessions/月与100k API requests/月分别列出，具体计量取决于接入；需 Key 与 Logo | 多种道路/户外/卫星样式，数据来源较多；仍需核实旅行目的地的 POI | MapLibre 兼容。免费额度有限，未以付费计划自动补量；无 Key，未实测 | 定价页 Static Maps 列在 Flex 功能；不能假设免费套餐允许本项目离线 HTML 导出 |
| 高德 | 个人认证、用途和协议决定免费配额，不能视为永久无限免费 | 若以后重点做中国境内旅行可专项评估；当前德国项目不优先 | 需实名认证、Key、安全配置及坐标转换，维护成本更高；未实测 | 不直接用于现有离线下载。先核对许可；现有 OSM/WGS84 坐标不能直接混用中国地图坐标体系 |

来源：[OpenFreeMap 官方](https://openfreemap.org/)、[服务条款](https://openfreemap.org/tos/)、[Protomaps 下载说明](https://docs.protomaps.com/basemaps/downloads)、[区域提取教程](https://docs.protomaps.com/guide/getting-started)、[Geoapify 定价](https://www.geoapify.com/pricing/)、[静态地图计费](https://apidocs.geoapify.com/docs/maps/static/)、[MapTiler Cloud 定价](https://www.maptiler.com/cloud/pricing/)、[高德服务升级](https://developer.amap.com/upgrade)、[高德授权说明](https://lbs.amap.com/faq/advisory/authorization/43168)、[高德坐标转换说明](https://lbs.amap.com/api/javascript-api-v2/guide/transform/convertfrom)。

OSM 官方公共瓦片服务明确禁止离线预取/批量下载，所以不作为下载按钮的替代源。[官方 Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)

## 速度证据及限制

本 VPS 单次 HTTPS 探测：OpenFreeMap Liberty 样式 43,079 字节，首字节约 0.164 秒；Protomaps 固定源头部 Range 127 字节，约 1.498 秒；travel 自有样式 19,679 字节，约 1.925 秒。HTTP 状态分别为 200、206、200。

这是服务器端单次不同资源的连通性检查，不是手机整图加载基准，也不能据此排列供应商速度。Geoapify、MapTiler、高德没有配置账号/Key，未做同条件性能测试。免费公共实例无法保证始终快；德国旅行的详细程度还受图层样式、缩放级别、OSM 数据与本地缓存影响。

## 本次下载故障与修复

线上真实点击下载没有文件生成，地图准备 POST 返回 500。定位到本项目 `/var/cache/travel/maps/.map-pack.lock` 为 root:root 0644，systemd 后端用户 travel 无法写锁。已仅修正该锁文件所属用户为 travel:travel；未删除地图包、旅程或数据库。以 travel 用户执行现有提取脚本，德国示例返回全程及10天完整缓存，missing 为空。修复后线上真实下载成功：约 6.07 MB 的 HTML 嵌入全程及10天共11张真实底图，无页面异常。

前端另补两层可靠性：地图准备成功时仍嵌入真实快照；单张地图失败保留其他快照。地图服务不可用时仍可下载日程、地点和行李，页面与离线文件均明确标记缺图，不宣称完整离线地图。生成后保留“保存离线文件”链接，可在 iPhone 上再次主动点击，避免仅依赖长时间异步后的自动下载。

离线地图仍是固定范围的截图，不能下载后自由缩放加载更多细节。Protomaps 官方仅保留最近一周及各补丁版本最后构建，未来新增区域时应检查固定源是否仍存在，按需更新配置；旧缓存不因此删除。

后续运维：地图脚本应通过 `runuser -u travel -- ...` 运行；不要以 root 直接运行并生成 root 所有的锁。生产认证凭据不得写入日志或报告。
