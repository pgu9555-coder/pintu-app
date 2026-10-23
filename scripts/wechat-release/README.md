# 拼途微信手动发布工具

此工具只生成预览或上传开发版本，不会自动提交审核、公开发布、修改微信后台、创建密钥或关闭 IP 白名单。微信官方工具来源：[wechat-miniprogram/miniprogram-ci-dist](https://github.com/wechat-miniprogram/miniprogram-ci-dist)。固定版本 `2.1.48`，已核对 npm 官方登记的仓库与安装源。

## 先检查，后接入账号

在仓库根目录运行，无需任何凭据或网络：

```powershell
node scripts/wechat-release.cjs --help
node scripts/wechat-release.cjs --mode preview --version 1.0.0 --dry-run
node scripts/test-wechat-release.cjs
```

检查 AppID、页面文件、项目目录、文件排除和密钥放置。干运行不读取密钥内容，也不加载 CI。现有小程序沿用 AppID `wxe1fe19432c29e3cd`；默认目录为 `miniprogram-shell`。

需要实际预览/上传时，再将官方工具装到独立目录，不修改根项目或云函数依赖：

```powershell
pnpm --dir scripts/wechat-release install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
```

脚本不会自动安装任何包。此目录包含独立 `pnpm-lock.yaml`，固定官方 `miniprogram-ci@2.1.48` 及依赖完整性哈希；不会改动网页或云函数运行时依赖。安装关闭生命周期脚本，安装源固定为 npm 官方 registry。工具未安装时，脚本会给出手动安装提示。

已在本机安装并验证官方包版本。没有代码上传密钥时，官方 `ci.Project` 构造立即返回 `privateKeyPath should not be empty`；因此当前没有完成官方编译、预览或上传。`--dry-run` 只代表本地配置检查成功，不代表微信编译成功。

## 管理员需要完成

1. 在微信公众平台为现有小程序下载**代码上传密钥**，放到小程序项目和 Git 仓库之外。
2. 配置实际执行机器的出口 IP 白名单，不需要关闭白名单。
3. 本地设置 `PRIVATE_KEY_PATH` 指向该文件，或使用 `--private-key` 传本地路径。不要把文件内容粘贴进聊天，不要提交或打包密钥。

```powershell
$env:PRIVATE_KEY_PATH = '管理员已保存的项目外密钥绝对路径'
node scripts/wechat-release.cjs --mode preview --version 1.0.0 --desc '原生界面与功能更新' --qrcode '项目外二维码输出绝对路径.png'
node scripts/wechat-release.cjs --mode upload --version 1.0.0 --desc '原生界面与功能更新'
```

预览二维码由获授权体验人员扫码。上传只是生成微信后台开发版本；仍需真实设备验收、后台备案/隐私/接口权限核验、提交审核，审核通过后才可公开发布。不要把上传成功当成正式上线成功。

## 文件保护

上传忽略 `node_modules`、Git、`.env*`、密钥/证书、private/secret 文件、日志、README 和测试文件。项目符号链接会被拒绝；私钥必须在小程序目录外。脚本不生成 ZIP，也不输出密钥、第三方原始结果或原始错误。不要将下载的凭据放进任何交付包。

GitHub 工作流不会自动运行此工具。预览/上传需手动执行，并以运行结果和微信后台开发版本为准。
