# 安全说明

这个插件在本地替你**下载、解包并执行**东西，所以把边界写清楚。

## 它下载什么

| 来源 | 内容 | 校验 |
|---|---|---|
| `github.com/erkamyaman/rust-anything` releases | CLI 二进制（按平台挑 asset：Windows x64 zip / macOS universal / Linux tarball）、`SHA256SUMS`、workflow skill | 下载后逐文件比对 `SHA256SUMS`，不匹配即中止 |
| 官方与国内镜像（TUNA / 华为云 / 阿里云 / rsproxy / python.org / Adoptium / golang.google.cn / dl.google.com / windows.php.net / builds.dotnet） | 工具链安装包（MSI / zip / tarball） | 全部 HTTPS；不校验上游签名（与手装等价） |
| `winget` | 少量回退项（如 MSVC Build Tools） | 由 winget 自己校验 |

所有下载都落在 `<DSH_HOME>/plugins-data/rust-anything/` 下，不会写系统目录（除 winget 安装项）。

## 它执行什么

- **`ra_install`**：解包并替换插件数据目录里的 CLI；
- **`ra_bootstrap`**：运行你选择的工具链安装器（MSI 静默安装、zip 解包、`rustup-init`、`cargo install` 等）；
- **`ra_cli` 与 16 个 MCP 工具**：以你的身份执行本地 `rust-anything` 二进制，参数由模型给出。

也就是说：**模型能让你机器上的 rust-anything 跑任意子命令**（它会创建 crate、跑 cargo、读写项目文件）。这等同于你在终端里敲同样的命令，但也意味着——不要在不信任的会话里把工具面开到 `all`。

## 本地管理接口

页面与 CLI 通过 `http://127.0.0.1:<port>/rust-anything/api/*` 通信：

- 每个 Harness 进程生成一个 64 hex 的 **Bearer token**，写在 `<data>/http.token`（`0600`，Windows 上由 profile 目录权限继承）；
- 除 `/api/token` 外全部要求 `Authorization: Bearer <token>`；
- 额外做 **loopback 围栏**：`Host` 必须是 loopback（或配置的 `trustedHosts`），`Origin` 必须是 loopback 或 `app://`，跨站来源直接 403；
- 没有 token 的请求一律 401——同机其他进程也读不到管理面。

`/api/token` 本身只对 loopback 开放，作用是在页面里引导出 token（页面同源加载）。

## 进程与文件

- 插件会拉起一个 `rust-anything mcp` 子进程，卸载/停用时终止；
- 后台任务（安装、bootstrap）可以被取消：`{cancel:true}` 会杀掉对应的 curl/cargo 子进程；
- 状态写在 `<data>/{bridge.json,bootstrap.json,install.log,http.token}`；卸载不删除 CLI 与已装的工具链。

## 报告问题

发现安全问题请开 issue（或按仓库主页给出的私下联系方式）。请附：DSH 版本、Windows 版本、`ra_status` 的输出（可脱敏）、复现步骤。

请**不要**在 issue 里贴 token、内网 IP、完整日志中的绝对路径。
