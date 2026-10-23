# 拼途部署与上线清单

此文档记录当前部署方式、账号配置和仍未完成的上线事项。状态整理于 **2026-10-22**；实时套餐、权限、备案和审核结果以对应平台控制台为准。

## 当前状态

| 项目 | 已有内容 | 仍需完成 |
| --- | --- | --- |
| 网页工具 | Vercel 托管，本机工具与地图入口 | 中国大陆网络及实际手机浏览器体验复核 |
| 网页多人协作 | CloudBase 测试站和受保护云函数 | 正式网页域名及套餐条件、生产访问方案 |
| 原生小程序 | 代码已与本轮网页界面、账本、备份和协作流程对齐 | 微信官方编译、双端真机预览、上传、提审及发布 |
| 微信账号 | 基础信息与类目流程已配置 | 核对 AppID、具体类目、管理员/开发者权限；备案待完成 |
| 小程序隐私与接口 | 源码已声明 `chooseLocation`，按用户操作触发授权与数据使用 | 核对后台隐私指引、实际检测接口及 `chooseLocation` 的申请结果 |

代码检查通过、云函数部署成功、上传开发版本、审核通过和公开发布分别是不同状态。当前不能将本项目标为“微信小程序已上线”。

## 环境与入口

| 配置 | 当前值 / 用途 |
| --- | --- |
| CloudBase 环境 | `pintu-prod-d1grnmzg0f6778ea6`，上海 `ap-shanghai`，文档型云数据库 |
| 网页工具与地图代理 | [pintu-app-nu.vercel.app](https://pintu-app-nu.vercel.app/) |
| 多人协作测试网页 | [腾讯云测试站](https://pintu-prod-d1grnmzg0f6778ea6-1303073868.tcloudbaseapp.com/) |
| 小程序源码 AppID | `wxe1fe19432c29e3cd`；提交前应与原账号后台核对 |
| 体验环境期限 | 体验期记录至 2027-04-22；到期时间、续期资格和实时配额需在腾讯云复核 |

当前 CloudBase 免费体验配置不能新增外部网页安全域名，因此 Vercel 的多人协作入口会引导打开默认允许的腾讯云测试站。该测试域名不能当作正式生产网页地址。

原生小程序使用 `wx.cloud` 调用同一 CloudBase 后端，不嵌入 Vercel 网页。**这类云函数调用不要求为了临时网页另购域名**；仍需正确关联微信账号与云环境。正式网页域名是另一个配置事项。

## 配置位置

### Vercel 项目

| 环境变量 | 含义 |
| --- | --- |
| `AMAP_JS_API_KEY` | 高德 JavaScript API Key |
| `AMAP_SECURITY_JS_CODE` | 高德安全码，仅服务端保存 |
| `PINTU_ALLOWED_ORIGINS` | 地图代理允许的精确 HTTPS 来源，多个来源用逗号分隔；配置实际使用的网页来源 |
| `CLOUDBASE_ENV_ID` | 可选，构建时覆盖 CloudBase 环境标识 |
| `PINTU_MAP_PROXY_ORIGIN` | 可选，地图代理所在 HTTPS 来源，不含路径或末尾斜杠 |
| `PINTU_COLLAB_ORIGIN` | 可选，多人协作网页所在 HTTPS 来源，不含路径或末尾斜杠 |

高德 JS Key 的域名白名单还要匹配网页实际域名。Vercel 代理仅允许固定高德路径，并使用服务端安全码；实例内限频不能代替高德服务商配额。

### GitHub Actions

**Secrets**：`TCB_SECRET_ID`、`TCB_SECRET_KEY`；小程序地图搜索还需要 `AMAP_WEB_SERVICE_KEY`。后者必须是高德 **Web 服务** Key，不能使用 JavaScript API Key 替代。

**Variables**：可选的 `CLOUDBASE_ENV_ID`、`TCB_REGION`、`AMAP_JS_API_KEY`、`PINTU_MAP_PROXY_ORIGIN`、`PINTU_COLLAB_ORIGIN`。这里的 JS Key 是公开标识，`AMAP_SECURITY_JS_CODE` 和 Web 服务 Key 不得放入公开变量或源码。

地图 Web 服务 Key 只注入临时云函数部署配置。没有 `AMAP_WEB_SERVICE_KEY` 时，工作流会跳过 `mapGateway` 部署，继续其他检查与部署；这不能证明小程序地址搜索可用。更新仓库 Secret 不会触发普通 push，应手动运行部署工作流应用新值。

### 微信原生项目

`miniprogram-shell/project.config.json` 保存 AppID；`miniprogram-shell/environment.js` 保存公开环境标识。导入和发布步骤见 [小程序指南](miniprogram-shell/README.md) 与 [微信手动发布工具](scripts/wechat-release/README.md)。代码上传私钥必须保存在 Git 仓库和小程序目录之外。

Fork 或新建环境时请替换为自己的账号配置，勿将现有生产环境当作公共后端。

## 部署与验收

### 网页与云函数

1. 核对当前分支、目标环境和所需密钥名称，确认没有把凭据写进待提交文件。
2. 在 Node.js 20 环境运行 `node scripts/prepare-release.cjs`，生成 `cloudbase-site/`。该脚本同时更新网页、CloudBase 和小程序的公开环境配置。
3. 应用文件合入 `main` 后，按路径过滤触发 [.github/workflows/deploy-cloudbase.yml](.github/workflows/deploy-cloudbase.yml)。也可以在 [Actions](https://github.com/pgu9555-coder/pintu-app/actions) 手动触发。纯文档更新未必触发 CloudBase 部署。
4. 工作流运行 14 组源码与行为检查，安装并审计三个云函数的锁定依赖后，再运行 1 组运行时依赖兼容检查；随后准备集合与索引、应用数据库规则、部署云函数、应用函数调用规则及上传静态站点。
5. Vercel 使用 `vercel.json` 的构建命令和代理路由单独部署。分别检查两个平台的结果，不能仅看 Git 提交成功。

现有检查脚本位于 [`scripts/`](scripts/)，例如：

```bash
node scripts/test-room-gateway.cjs
node scripts/test-map-gateway.cjs
node scripts/test-miniprogram-native.cjs
node scripts/test-native-backup.cjs
node scripts/test-native-account-isolation.cjs
```

完整顺序以工作流为准。`test-runtime-dependencies.cjs` 需要先安装各云函数的锁定依赖。云函数当前锁定 CloudBase Node SDK 3.18.7、微信服务端 SDK 4.0.2，并覆盖其部分传递依赖；维护锁文件或覆盖版本时，应同时检查依赖审计、真实 SDK 接口和云端业务兼容性。

数据库默认拒绝客户端直接读写受保护集合；云函数默认拒绝调用，仅显式开放已认证的 `roomGateway` 和 `mapGateway`。`request_limits` 只允许服务端读写，`quotaCleanup` 定时清理过期计数，不处理账本或成员数据，也不向客户端开放。每轮最多清理 2,000 条，并在删除时重新检查过期时间。

### 真实业务验收

- 两个独立身份创建、加入、同步、退出、重新加入、房主转让与解散，确认旧成员和旧设备写入被拒绝。
- 地址输入、手动选点、地点搜索、分类与详情、投票、确认、盲盒，以及服务失败时的错误提示与重试。
- 账本成员与支出的增改删、多人分摊、分的余数、余额与转账建议。
- 本机保存失败提示、刷新恢复、账户隔离、退出登录后未完成请求的隔离。
- 网页与小程序 JSON 备份互导，确认导入新增本机副本，不恢复云端权限。
- 小程序 iOS / Android 真机的地图、隐私授权、文件选择/分享、头像、邀请卡片与双人跨端同步。

离线源码和 VM 检查不能代替实际云环境、真实位置、微信官方编译或手机验收。请记录所验收的提交、环境、设备与结果；未执行的项目保留为待办。

## 小程序提审前待办

- [ ] 在原账号核对 AppID、主体、具体服务类目及管理员/开发者权限。
- [ ] 继续后台备案流程，当前备案待完成。
- [ ] 按实际数据用途配置“用户隐私保护指引”，检查 `chooseLocation` 等检测项与接口审批结果。
- [ ] 核对小程序与 CloudBase 环境关联，验证地图 Web 服务 Key 与内容安全调用可用。
- [ ] 用官方开发者工具或手动 CI 生成预览，完成 iOS / Android 及双身份测试。
- [ ] 准备一致的名称、简介、图标、功能截图、审核路径和审核说明。
- [ ] 上传开发版本，确认微信后台实际版本，再提交审核；审核通过后另行发布。

管理员如采用官方 CI，需下载代码上传密钥并配置执行机器的出口 IP 白名单。不要关闭白名单，也不要把私钥内容放入聊天、Issue 或发布包。当前仓库工具的 `--dry-run` 只检查本地配置，不代表微信编译或上传成功。

## 更换正式网页域名

保留同一 CloudBase 环境和 AppID，可继续使用相应云端数据。正式网页需先核实套餐及域名条件，再同步更新：

1. CloudBase 网页安全域名与登录配置。
2. 高德 JS Key 域名白名单。
3. Vercel 的 `PINTU_ALLOWED_ORIGINS`。
4. 构建配置 `PINTU_MAP_PROXY_ORIGIN`、`PINTU_COLLAB_ORIGIN`，随后重新部署。

浏览器本机账本与匿名身份不会自动跟随域名迁移。应先导出账本；房主应在旧域名可访问时，将管理权转给能长期访问房间的成员。导入备份只创建本机账本，不能恢复旧匿名身份或云端房主权限。

## 运营前复核

- 腾讯云体验期限、资源配额、超限策略和备份安排。当前默认域名仅用于测试，参见 [CloudBase 默认域名说明](https://docs.cloudbase.net/service/introduce)。
- 地图服务的用途授权、Key 配额与白名单；按照实际运营用途核对 [高德许可说明](https://lbs.amap.com/faq/advisory/authorization/43168)。免费额度不代表全部用途均获许可。
- Vercel、地图和协作入口在中国大陆不同网络及手机上的访问表现。
- 新地图 Key 验证后，排查旧网页曾使用的 Key / 安全码是否仍被其他应用依赖，再由账号管理者停用不再使用的旧凭据。
- 隐私说明、用户协议和联系渠道与真实功能一致，公开截图与公告不包含房间邀请码、个人信息、账本或凭据。
