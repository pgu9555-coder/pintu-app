# 拼途发布配置

## 环境

- CloudBase：`pintu-prod-d1grnmzg0f6778ea6`，上海，云数据库（文档型）。
- 网页工具及地图代理：`https://pintu-app-nu.vercel.app`，Vercel 托管。
- 多人协作测试网页：`https://pintu-prod-d1grnmzg0f6778ea6-1303073868.tcloudbaseapp.com`。
- 微信小程序 AppID：`wxe1fe19432c29e3cd`。
- 免费环境当前到期日：2027-04-22；续期资格和配额以腾讯云控制台为准。

## 发布前配置

1. CloudBase 开启匿名登录。当前免费体验版禁止新增外部安全域名，因此网页协作使用已默认允许的腾讯云测试域名；Vercel 页面提供明确的测试入口。小程序使用自己的微信登录。
2. Vercel Production 设置 `AMAP_JS_API_KEY`、`AMAP_SECURITY_JS_CODE`、`PINTU_ALLOWED_ORIGINS`（精确 HTTPS 来源，逗号分隔）。安全码只保存在服务端环境变量。
3. Vercel 可设置 `CLOUDBASE_ENV_ID`、`PINTU_MAP_PROXY_ORIGIN`、`PINTU_COLLAB_ORIGIN`；未设置时使用仓库配置。`PINTU_ALLOWED_ORIGINS` 当前包含 Vercel 和腾讯云测试地址。
4. GitHub Actions secrets 保留 `TCB_SECRET_ID`、`TCB_SECRET_KEY`，小程序地图搜索还需要 `AMAP_WEB_SERVICE_KEY`。后者是 Web 服务 Key，不能用 JS API Key 代替。
5. GitHub Actions variables 可配置 `CLOUDBASE_ENV_ID`、`TCB_REGION`、`AMAP_JS_API_KEY`、`PINTU_MAP_PROXY_ORIGIN`、`PINTU_COLLAB_ORIGIN`。这里的 JS Key 是公开标识，安全码不得存入 variables。
6. 高德 JS API Key 白名单需要匹配实际网页域名，并设置服务商配额。Vercel 代理的实例内限频不能替代服务商配额。
7. 微信开发者工具导入 `miniprogram-shell`。发布前在微信后台完成类目、备案、隐私声明、位置接口申请和真机审核流程；是否获批由微信后台决定。

## 部署与验证

`node scripts/prepare-release.cjs` 生成网页产物 `cloudbase-site`，并统一网页、小程序和 CloudBase 配置。
推送 main 会触发 Vercel 和 CloudBase 工作流。工作流先运行七组检查，然后部署数据库权限、索引、云函数及静态托管。

`request_limits` 只允许服务端读写。`quotaCleanup` 每小时清理过期计数，不处理账本或成员数据；客户端调用由默认函数规则拒绝。每次最多处理 2,000 条，并在删除时再次检查过期时间，保护已续期的计数。

三个云函数使用已锁定的依赖树。当前使用 CloudBase Node SDK 3.18.7、微信服务端 SDK 4.0.2，并覆盖上游仍固定使用的旧版 HTTP/数据库依赖为 axios 0.34.0 和 @cloudbase/database 2.0.0。发布前运行 `npm ci`、`npm audit` 和实际 SDK 的查询、日期、更新、事务、身份/内容安全接口兼容检查。更新这些覆盖版本后，还需复测真实云房间；不能仅凭依赖扫描为零判断业务兼容。

上线验收必须包含两个独立身份的创建/加入/同步/退出/房主转让、地图地址搜索、结算、备份导入导出、权限拒绝及小程序真机验证。本地模拟检查不能代替云端和真机验收。

## 更换正式域名

继续使用同一 CloudBase 环境和 AppID 即可保留云端数据。正式网页需要先解决套餐和域名要求，再更新 CloudBase 安全域名、高德白名单、Vercel `PINTU_ALLOWED_ORIGINS`、`PINTU_MAP_PROXY_ORIGIN` 和 `PINTU_COLLAB_ORIGIN` 后重新部署。
浏览器本机账本和匿名身份不会随域名迁移：用户应先导出账本；房主应在旧域名还能访问时将管理权转给能长期访问的成员。导入备份只创建本机账本，不恢复云端身份。

## 外部上线条件

- 高德免费额度不等于所有公开运营用途均已授权。正式公开服务前，依据 [高德技术服务许可说明](https://lbs.amap.com/faq/advisory/authorization/43168) 核实实际用途；个人研究学习之外的用途需向高德确认许可。
- Vercel 和地图代理的中国大陆访问质量需要在大陆网络实测。当前托管地址是临时地址。
- 免费 CloudBase 有到期日和资源上限；控制台当前未启用 QPS 超限按量。
- 腾讯云默认网页域名仅供开发测试，不能作为已满足生产上线条件的依据。参见 [默认域名限制](https://docs.cloudbase.net/service/introduce)。
- 旧网页曾暴露的地图安全码应在新 Key 上线验证后停用；先确认旧 Key 未被其他应用依赖。
