# 第三方组件与致谢

## rust-anything

本插件是 [rust-anything](https://github.com/erkamyaman/rust-anything) 的 Harness 集成层：它**不包含** rust-anything 的源码，而是在运行时下载官方 release 的二进制并调用它。

- 项目：https://github.com/erkamyaman/rust-anything
- 作者：Erkam Yaman
- 许可：MIT

`ra_install` 会在下载后校验官方 `SHA256SUMS`，再解包到 `<DSH_HOME>/plugins-data/rust-anything/`。

## DeepSeek Harness

本插件运行在 DeepSeek Harness 之上，使用其插件机制（bundle patch、`ctx.tools.register`、client slot、`webServer` 路由）。DSH 本身不随本仓库分发。

## dsh-craft-anything

早期实现参考了 `dsh-craft-anything` 的 slot / bundle-patch 接线方式与页面结构思路；本仓库不包含其源码。

## 运行时下载的第三方工具链

`ra_bootstrap` 安装的工具链（Rust、MSVC Build Tools、Node.js、Python、Go、JDK、Ruby、PHP、.NET、wasm-bindgen、kotlinc、Android NDK）各自遵循其上游许可，均从官方或官方镜像下载，不随本仓库分发。