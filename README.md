<img src="assets/pintu-miniapp-avatar-v1.png" alt="拼途" width="88">

# 拼途 · Pintu

和朋友约个地方、做个决定、把账算清楚。

拼途是一个面向小型聚会的协作工具：寻找参考中点、推荐附近去处、投票选地点，用转盘解决选择困难，再用共享账本整理同行花费。仓库包含网页、原生微信小程序和 CloudBase 云函数。

[在线体验](https://pintu-prod-d1grnmzg0f6778ea6-1303073868.tcloudbaseapp.com/) · [部署与上线状态](LAUNCH.md) · [小程序开发指南](miniprogram-shell/README.md) · [更新公告与发布包](https://github.com/pgu9555-coder/pintu-app/releases) · [文档导航](docs/README.md)

## 现在可以体验什么

| 入口 | 当前用途与状态 |
| --- | --- |
| [拼途网页](https://pintu-prod-d1grnmzg0f6778ea6-1303073868.tcloudbaseapp.com/) | 统一入口：地图、转盘、账本、房间协作均在同一网页内使用。 |
| 托管说明 | 当前使用腾讯云默认域名；Vercel 仅保留地图代理等技术服务，不再作为推荐入口。 |
| 原生微信小程序 | `1.1.12` 已通过官方编译、生成预览码并上传开发版；手机真机体验、备案与接口核验、提审和正式发布仍待完成。 |

以上是 2026-10-23 整理的项目状态。代码完成、后端部署和微信正式发布是不同阶段；最新部署结果请查看 [GitHub Actions](https://github.com/pgu9555-coder/pintu-app/actions)。

## 功能

- **寻找中点**：本机填写多个出发地，或在多人房间各自填写；根据坐标计算参考中点，浏览附近咖啡、餐厅和商圈。原生小程序的本机出发点支持手工搜索地址并选择有效结果，也可单独打开地图选点。
- **一起选地方**：提议地点、投票、由房主确认目的地；也可以通过目的地盲盒逐个查看、跳过和收藏。
- **谁买单 · 转盘**：本机随机选择，完成动画后显示结果；名单和结果不上传共享房间，也不跨会话保存。
- **行程账本**：管理同行成员，新增、修改和删除支出，选择付款人与分摊人，查看余额及转账建议。金额按整数分计算；不能整除时余下的分按该笔分摊人顺序分配。
- **房间管理**：通过 8 位邀请码进入碰面或账本房间；支持退出、房主转让和解散。网页与原生客户端使用同一套受保护的房间协议。
- **备份与迁移**：网页与小程序使用兼容的 JSON 账本格式。导入创建独立本机账本，不覆盖原账本，也不恢复云端身份、房主权限或房间访问权。

> 中点是坐标估算，不能保证每个人路程或耗时相同。确认地点前，请结合公共交通、实际道路和个人需求判断。

### 一个人也能规划碰面

进入碰面房间后，可用“手动添加出发点”为未登录的同行者选择地址。自己的有效出发点加一条手动地点即可计算本机参考中点。手动地点按当前账号与房间保存在本机，不会变成房间成员，也不会自动同步或参与共同投票。

### 网页与小程序的对应关系

| 能力 | 网页 | 原生小程序源码 | 数据范围 |
| --- | --- | --- | --- |
| 中点、附近地点、盲盒 | 支持 | 支持 | 本机草稿 / 已加入的共享房间 |
| 地点投票、房主确认 | 支持 | 支持 | 共享房间 |
| 账本、支出编辑、结算 | 支持 | 支持 | 本机 / 共享房间 |
| 房主转让、成员退出、解散 | 支持 | 支持 | 共享房间 |
| JSON 账本备份 | 支持 | 支持 | 当前设备已保存或下载的数据 |
| 转盘 | 支持 | 支持 | 当前会话 |
| 微信资料、邀请卡片、云端房间历史 | — | 支持 | 经授权的微信身份 |

English summary: Join the same protected room from the web application or WeChat Mini Program with an eight-character invitation code. This describes the client protocol; the Mini Program has not been released on WeChat.

## 开发入口

网页使用原生 HTML、CSS 和 JavaScript，没有根目录前端依赖安装步骤；地图、云端身份及协作仍依赖对应平台服务。部署工作流使用 Node.js 20。

```bash
git clone https://github.com/pgu9555-coder/pintu-app.git
cd pintu-app
node scripts/prepare-release.cjs
```

该命令生成 `cloudbase-site/` 网页产物，同时更新公开配置 `app-config.js`、`cloudbaserc.json` 和 `miniprogram-shell/environment.js`。自建环境前请先阅读 [LAUNCH.md](LAUNCH.md)，避免误用现有环境。

- **网页预览**：用静态 HTTP 服务打开 `cloudbase-site/` 可查看页面和本机逻辑。静态服务不提供 `api/amap.js`，`localhost` 也未默认加入地图与云端允许域名；完整联调需要配置自己的测试环境。
- **小程序**：将 `miniprogram-shell/` 导入官方微信开发者工具。复用本项目账号需要管理员授权；Fork 项目请使用自己的 AppID、CloudBase 环境和平台配置。参见 [小程序指南](miniprogram-shell/README.md)。
- **检查**：现有检查脚本位于 `scripts/test-*.cjs`，工作流包含 15 组源码、行为和运行时依赖检查。执行方式及验收边界见 [发布清单](LAUNCH.md#部署与验收)。离线检查不代替云端联调或微信真机验收。

## 结构

```text
.
├── index.html / midpoint.css / midpoint-ui.js  网页界面与中点交互
├── launch-support.js / app-config.js          备份、上线辅助与公开配置
├── api/amap.js                               Vercel 地图代理
├── miniprogram-shell/                        原生微信小程序（非 web-view）
├── cloudfunctions/
│   ├── roomGateway/                          身份、房间、投票与账本
│   ├── mapGateway/                           小程序地图搜索与地点详情
│   └── quotaCleanup/                         过期限流记录清理
├── cloudbase-security-rules.json              数据库访问规则
├── cloudbase-function-security-rules.json     云函数调用规则
├── scripts/                                  部署、检查与微信手动上传工具
├── .github/workflows/deploy-cloudbase.yml     CloudBase 部署流程
└── docs/README.md                            文档导航
```

## 数据与权限

共享数据由 `roomGateway` 校验身份和成员权限，客户端不能直接读写 `rooms`、`user_profiles` 等受保护集合。当前房间协议使用 `schemaVersion: 5`；每次重新加入生成新的 `membershipEpoch`，旧设备和已退出成员不能继续用旧授权修改房间。房间持续保留至房主解散。

房间码具有邀请凭据作用，请仅分享给准备加入的人。微信身份来自可信调用上下文的 OpenID；头像使用私有存储、账户路径和可重试清理流程。面向小程序展示的用户文本经过微信内容安全流程。地图安全码和 Web 服务 Key 保留在服务端，不应写入公开配置、客户端或备份。

原生小程序可在拒绝位置授权后手工搜索公开地点，不读取当前位置。搜索关键词会经 CloudBase 地图网关发送给高德，服务端根据平台可信调用标识的哈希值限流；本机搜索不会创建已保存的云端协作资料。地图选点的数据用途说明覆盖出发点和候选目的地。

本机数据依赖当前浏览器或微信设备的存储。小程序游客草稿与登录账户空间分开，登录不会自动合并游客草稿。更换浏览器、清理缓存、切换域名或换设备前，请主动导出账本。小程序备份只包含本机账本及已下载的共享快照，不会自动下载所有云端账本。

- [网页隐私说明](https://pintu-prod-d1grnmzg0f6778ea6-1303073868.tcloudbaseapp.com/privacy.html)
- [网页用户协议](https://pintu-prod-d1grnmzg0f6778ea6-1303073868.tcloudbaseapp.com/terms.html)
- [安全问题报告方式](SECURITY.md)

## 部署与后续上线

CloudBase 托管统一网页入口，Vercel 保留地图代理和兼容旧页；CloudBase 工作流在应用相关文件更新到 `main` 或手动触发时，运行检查、应用访问规则并部署云函数和测试网页。地图云函数还需要独立的 AMap Web 服务 Key。所需变量、密钥名称、配额和域名迁移步骤见 [LAUNCH.md](LAUNCH.md)。

2026-10-23 已通过官方微信开发者工具 `2.02.2609231` 完成编译、预览码生成，并上传 `1.1.12` 开发版，包体为 276,531 字节（约 270 KB）。本次未完成手机真机体验，也未提交审核或正式发布。备案、隐私指引、位置接口权限、云存储规则及实际业务调用仍需核验。

官方只读 CLI 在指定 AppID 和环境后可列出三个云函数，函数状态均为 `Active`；环境列表返回空，不能据此判断环境已关联或未关联。账号与环境关联及运行时调用仍待核实。

后续微信预览与上传通过 [手动发布工具](scripts/wechat-release/README.md) 或官方开发者工具单独进行。仓库推送不会自动提交微信审核或公开发布。

## 反馈与贡献

使用问题、改进建议或可复现的缺陷，请通过 [Issues](https://github.com/pgu9555-coder/pintu-app/issues) 提交，并注明使用的是统一网页入口还是小程序开发版。截图请遮住房间码、个人信息及账本内容。

贡献流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。私密问题可联系 [pgu9555@gmail.com](mailto:pgu9555@gmail.com)，请勿提交密码、验证码、密钥或真实用户数据。

## 许可证

本仓库代码沿用现有 [MIT License](LICENSE)。地图、云服务和微信平台的使用仍需遵守相应服务条款。
