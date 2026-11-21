# Changelog

## Unreleased

### CI

- 增加 `lint` 作业：actionlint 覆盖 YAML 语法、未知键、`uses` 引用、`${{ }}` 表达式与 `run` 块的 shellcheck，跑在 `ubuntu-latest`，十几秒；
- `actions/checkout` 与 `actions/setup-node` 升到 **v5**——`node20` runtime 已被 GitHub 标记弃用（2026-09 移除）；
- 修掉一个让整个工作流非法的 YAML 错误：step 名里未加引号的 `": "` 被当成映射键，导致每次 push 的 run 都不产生任何 job（徽章直接红）。

## 0.1.0-beta.1

首个公开版本。功能齐了，范围也划清了：**Windows only，DSH `0.2.2-rc.3` 上端到端验证**。

### 工具

- 16 个 MCP 工具按档位注册为 `mcp__rust_anything__*`（`off` 0 / `plan` 5 / `port` 11 / `all` 16），自带 stdio MCP 客户端，不依赖 `@deepseek-ai/dsh-mcp-client`；
- `ra_status`：CLI 路径与来源、安装根、版本、工具计数、doctor、当前项目（含已有 `rust/` crate）、skill 状态；
- `ra_cli`：透传任意 CLI 参数，输出裁剪与退出码；
- `ra_install`：下载/更新 CLI，校验 `SHA256SUMS`，装 skill；支持中止；
- `ra_surface`：切档位或自定义 allow 列表；
- `ra_bootstrap`：后台安装工具链，可取消、可续传、返回前几行日志。

### 页面

- 状态 / 环境与依赖 / 移植看板 / 工具面四张卡；
- 环境项按绿黄红点区分，`cc` 走 `vswhere`、`kotlinc` 识别 `.bat`，`agents` 永不安装；
- 运行中的任务有 **停止**按钮（中止 curl / cargo 子进程）；
- 页面级与 chip 级 **错误边界**：渲染失败显示原因而不是空白。

### 安装器

- 覆盖 cargo、MSVC、Node、Python、Go、JDK、Ruby、PHP、.NET、wasm32、wasm-bindgen、kotlinc、Android NDK、Android Rust targets；
- 镜像策略：官方 → 国内直连（TUNA / 华为 / 阿里 / rsproxy）→ 必要的 winget；
- 大文件 `curl -C -` 断点续传，每 50 MB 记一行进度；
- 安装完成后运行中的 Harness 立刻能看到新工具链（每次探测前重读机器级环境变量）。

### 修复过的坑（都在这版里）

- 相对 crate 路径在 Windows 上必失败（`rust-anything` 2.1 的 manifest 解析 bug）→ 代理工具统一把 `root` / `repo` / `cwd` / `out` / 存在的 crate 名解析成绝对路径；
- 默认项目目录取的是宿主进程 cwd（`profiles/desktop`）→ 改为会话工作区（`ctx.workingDirectory`），回退到 `projectDir`，再回退 cwd；
- 空工作台没有提示 → `ra_status` 明确说明并给出两种指路方式；
- 上次被中止的安装会一直显示「上一次安装被外部结束」→ 结算一次并只在真有失败项时提示；
- chip 上的工具计数从来没显示过（路由没发 `mcpTools`）→ 改为注册表实时计数；
- 打开页面就 spawn doctor（1–2 秒）→ `?doctor=1` 允许用缓存，只有「运行诊断」才重探（实测 3 ms vs 330 ms）；
- `ra_install` 卡住无法中断 → 支持 `{cancel:true}` 与 30 分钟上限。

### 已知限制

- 仅 Windows；macOS / Linux 未验证；
- 依赖 DSH 未公开的内部接口，升级 DSH 后请先跑测试；
- JSON 传输无法表达共享引用、循环引用、`RegExp` / `URL` / 大多数 TypedArray，相关 unit 落在输入域之外。