# Changelog

## 0.1.3

### 变更

- **撤掉 `ra_cli` 的沙箱包裹**：0.1.1 给它接了 `sandboxPolicy` + `ctx.sandbox.confine`，但 MCP 的 24 个工具——真正会写盘的 `build`/`gate`/`app_lift`——从来不经过这条路径，而默认会话策略是 `danger-full-access`，这段代码在常规使用下从不执行。留着一半执行的边界比没有更容易让人误判，所以整段删掉，插件不再声称约束执行。
- **未知参数改为警告**：`validateToolArgs` 之前拒绝 schema 之外字段。MCP 里未声明 `additionalProperties` 等于"任意字段都算合法"，拒绝会误伤确实接受额外字段的工具。现在 required 与类型仍然硬性校验，未知字段只在结果里附一条提示。

### 新增

- **`ra_install` 走 GitHub 镜像**：有些网络完全连不上 github.com（`fetch failed`）。现在直连失败后依次尝试 `ghproxy.net` / `gh-proxy.com` / `ghfast.top`；`api.github.com` 被镜像拒绝，所以 `latest` 的 tag 改从 `releases/latest` 的 Location 头里取，资产 URL 由 tag 推导（可预测才可镜像）。直连仍排第一，网络正常时不受影响。
## 0.1.2

### 新增

- **PHP 装上但 doctor 仍报缺**：便携版 PHP 自带 `php_ffi.dll` 却没有 `php.ini`，所以扩展从不加载，doctor 的 PHP 检查卡在 "FFI extension not loaded"（rust-anything 的 PHP 桥正是 FFI）。新增 `direct.ini`：解压后写 `php.ini`（`extension_dir` 指向 `<dest>\ext`、`extension=ffi`、`ffi.enable=true`）；已有 ini 只在未开启该扩展时追加，绝不覆盖用户配置。
- **`Android adb` 安装项**：rust-anything 5.x 的 doctor 会检查 adb，而 NDK 里不含它（adb 在独立的 platform-tools 包里）。现在 `bootstrap.js` 下载 `platform-tools-latest-windows.zip`、flatten 解压到 `<root>/platform-tools`、把该目录写进机器 PATH；`android` 与 `all` 两个 plan 都会带上它。
- **`cache/` 不再无限增长**：`installDirect` 解压成功后删掉归档（之前每装一轮工具链就多几百 MB，清空前是 937 MB）。代价是同版本重装要重新下载。
- **指南的语言列表补全**：`SKILL.md` 从 6 种语言补到 `analyze --lang` 实际枚举的 10 种（新增 Kotlin、PHP、C#、PowerShell），否则模型会把已有的桥当成不存在、绕过它做计划。
- **版本号追上代码**：`v0.1.1` 之后进了 adb 安装项与 PHP FFI 修复却仍自称 0.1.1，现统一为 0.1.2。

## 0.1.1

### 修复

- **`plan` / `port` 档位漏掉 CLI 新增的工具**：档位原本按写死的名字列表过滤，CLI 2.1.0 之后新增的 `go`、`fuzz`、`package`、`enable`、`disable`、`report` 在任何档位下都不可见（`port` 是日常档，等于 `go` 永远用不上）。现在档位由每个工具的 `annotations.readOnlyHint` 判定：`plan` = 只读工具 + `bridge`/`refresh`/`profile`，`port`/`all` = 服务器列出的全部。旧 `bridge.json` 里的名字列表会被识别为对应档位并迁移。
- **上游文档里的 CLI 回退指引已删除**：`SKILL.md` 里那段「MCP 工具不可用就用 CLI，装不上就跑 `rust-anything setup`」会与本插件的前言互相矛盾，模型可能照着回退。现在注册与写盘时删掉该段（其余逐字节不变），并在 `THIRD-PARTY-NOTICES.md` 记录删改内容。
- **调用前按 `inputSchema` 校验参数**：引擎的 MCP reader 把类型错的必填字段当成「未提供」，`{"port":"8080"}` 会静默退回默认值。现在校验 required / type / enum / 数组元素 / 数值范围 / 未知字段，报错直接点名字段与期望类型。

### 新增

- **MCP `instructions` 注入系统提示**：`initialize` 返回的那份「profile → record → port」总纲之前被丢弃，模型只看得到工具描述、不知道顺序。现在挂到 `MCP_SERVERS` 段（`interpolate: false`），并附一句禁止回退到 CLI / `rust-anything setup` / 改 PATH。
- **skill 改为运行时注册**：`ctx.skills.register()` 把 skill 注册到宿主，版本随插件走、卸载即注销；`~/.dsh/skills/rust-anything/` 的拷贝保留给读目录的消费者。`ra_status` 新增 `skill.registered`。
- **`ra_cli` 受会话沙箱约束**：这台机器上它是唯一能跑任意程序的入口，而插件的子进程本来不受 DSH 沙箱管辖。现在读会话的 `sandboxPolicy`，模式比 `danger-full-access` 严格时用 `ctx.sandbox.confine` 包住 argv；后端不可用的主机只记录一次并如实说明，不会假装已隔离。
- **工具链报错翻译成安装建议**：引擎只回一句 `running cargo: program not found`，模型会原样重试。现在按 `CHECKS` 给出安装命令，并说明必须重启 Harness（本进程持有启动时的 PATH）。
- **`upstream-lock.json` 双哈希**：`SHA256SUMS` 只能证明归档，跑起来的是里面那个 exe。现在按 tag + 平台钉住解压后的字节；未钉住的版本只报告不拒绝，钉住但对不上则删除并报错。
- **`release.yml`**：tag 触发时先校验 `tag == package.json == dsh.plugin.json` 并且 CHANGELOG 有对应小节，再跑四套测试、从 CHANGELOG 取正文发 release。v0.1.0-beta.1 那次 tag 指错 5 个 commit 的事故，就是为了不再发生。

## 0.1.0

首个正式版本。内容等于 `0.1.0-beta.4`，没有功能改动；`0.1.0-beta.1..4` 保留在下面作为历史。

支撑这个正式版的验证：四套测试 166 条断言、CI 在 `windows-latest` × node 22/24 + `actionlint` 上全绿、rc.1 与 rc.3 两台真机实测。范围仍是**仅 Windows**。

## 0.1.0-beta.4

### 样式

- 输入框左侧的「工具面」chip 改为与 `dsh-craft-anything` 同一视觉：`border-l2` 细边、12px、`5px 9px`、`radius 8`、7px 圆点、9px 箭头；**规划/移植/全部为橙色**（`state-warn-primary`，文字+边框+圆点同色），**关闭为灰色**（`label-secondary` + idle 圆点 + 0.7 透明度）；展开菜单只改背景，不再把档位色刷成白色。

## 0.1.0-beta.3

### 修复

- **环境卡把 agent 行当成可装项**：新版 CLI 把 `agents` 拆成 `Claude Code mcp` / `Claude Code skill` / `Gemini CLI mcp`，卡片按精确名字查 `NOT_INSTALLABLE` 时漏掉它们，于是显示「装」按钮并计进「待装」。现在与 `neverInstalled()` 同一判据，一律标成不装；
- **stale 任务的「仍缺少 …」**：那行是任务结束时的快照，重启打断后它与卡片上方的行互相矛盾；任务 stale 时不再显示。

## 0.1.0-beta.2

### CI

- 增加 `lint` 作业：actionlint 覆盖 YAML 语法、未知键、`uses` 引用、`${{ }}` 表达式与 `run` 块的 shellcheck，跑在 `ubuntu-latest`，十几秒；
- `actions/checkout` 与 `actions/setup-node` 升到 **v5**——`node20` runtime 已被 GitHub 标记弃用（2026-09 移除）；
- 修掉一个让整个工作流非法的 YAML 错误：step 名里未加引号的 `": "` 被当成映射键，导致每次 push 的 run 都不产生任何 job（徽章直接红）。

### 修复

- **装完 cargo 不补 PATH**：rustup 用 `--no-modify-path` 安装，而 `download` 分支从不应用 `CHECKS[*].env`，于是工具装好了 doctor 却一直报 missing。现在安装后按声明补 PATH（`ensureUserPath`）；
- **agent 家族被当成可装项**：新版 CLI 把 `agents` 拆成 `Claude Code mcp` / `Claude Code skill` / `Gemini CLI mcp`，这三个和 `agents` 一样永不由本插件安装，`neverInstalled()` 改为前缀匹配；
- **重启打断的任务永远显示「安装中」**：status / board / bootstrap 三条读路径改为共用 `settledBootstrapJob()`，读到 `running:true` 但进程内没有任务时立即结算并落盘。
### 兼容性

- **支持 DSH `0.2.2-rc.1`**：`engines.dsh` 从 `>=0.2.1-rc.2` 改为 `>=0.2.2-rc.1`。在隔离 profile 上用 rc.1 无头引导验证：`/rust-anything/api/token` 返回 64 hex、`/api/surface` 正常响应、`http.token` 落盘；页面未逐屏验收；
- **认识 `DSH_HOME`**：插件与 `install.ps1` 之前只认 `%USERPROFILE%\.dsh`，在设置了 `DSH_HOME` 的机器上会写到错误的家目录（实测会污染真实 home 的 `plugins-data`）；现在两者均优先取 `DSH_HOME`；
- **修掉 token 从不落盘**：`createHttpAuth` 抽成 `http-util.js` 时签名改了、函数体还引用已不存在的 `paths`，异常被静默 `catch` 吞掉。页面一直靠 `/api/token` 引导才没暴露；现在写对路径并且失败会告警。
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