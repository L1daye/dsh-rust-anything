# 第三方组件与致谢

## rust-anything

本插件是 [rust-anything](https://github.com/erkamyaman/rust-anything) 的 Harness 集成层：它**不包含** rust-anything 的源码，而是在运行时下载官方 release 的二进制并调用它。

- 项目：https://github.com/erkamyaman/rust-anything
- 作者：Erkam Yaman
- 许可：MIT

`ra_install` 会在下载后校验官方 `SHA256SUMS`，再解包到 `<DSH_HOME>/plugins-data/rust-anything/`。

### 对上游 skill 文档的一处修改

`skills/rust-anything/SKILL.md` 与 `whole-app.md` 取自上游同名文档。其中 `SKILL.md` **删掉了一段**，其余逐字节保持原样：

> If the MCP tools are not available, use the CLI; if `rust-anything` is not installed, ask the user to install it (`cargo install rust-anything`) and run `rust-anything setup`, then restart the agent.

删除原因：`rust-anything setup` 注册的是 Claude Code / Codex / Cursor / Gemini CLI / OpenCode，不是 DeepSeek Harness；而在这个插件里「MCP 工具不可用」正是插件自己负责修的状态（`ra_status` → `ra_install`）。把这段留在提示词里会与插件前置的前言互相矛盾，模型可能照着回退到 CLI。

除该段外，两份文档与上游一致；插件在文件前追加的 `<!-- dsh-rust-anything: … -->` 前言属于本仓库，不属于上游。

## DeepSeek Harness

本插件运行在 DeepSeek Harness 之上，使用其插件机制（bundle patch、`ctx.tools.register`、client slot、`webServer` 路由）。DSH 本身不随本仓库分发。

## dsh-craft-anything

早期实现参考了 `dsh-craft-anything` 的 slot / bundle-patch 接线方式与页面结构思路；本仓库不包含其源码。

## 运行时下载的第三方工具链

`ra_bootstrap` 安装的工具链（Rust、MSVC Build Tools、Node.js、Python、Go、JDK、Ruby、PHP、.NET、wasm-bindgen、kotlinc、Android NDK）各自遵循其上游许可，均从官方或官方镜像下载，不随本仓库分发。