// dsh-rust-anything — Client half.
//
// A "Rust Anything" entry in the sidebar rail (`sidebar.panellist`) and its page in the central
// column (`main`, keyed by the same id), plus one composer chip on the left of the input row that
// switches the MCP tool surface. The page reads live state from the Host half's routes
// (/rust-anything/api/{status,board,surface,install}); it never touches the DOM outside its own
// React tree and uses the Harness theme tokens with plain fallbacks.
//
// The page carries its own language switch (中文 / English, remembered in localStorage) and one
// install button that asks the Host half to fetch and verify the official release, so a missing
// CLI is fixed without leaving DSH.

window.__ModuleLoader__.load({
  id: 'dsh-rust-anything',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const PANEL_ID = 'rust-anything'
    const STATUS_ROUTE = '/rust-anything/api/status'
    const BOARD_ROUTE = '/rust-anything/api/board'
    const SURFACE_ROUTE = '/rust-anything/api/surface'
    const INSTALL_ROUTE = '/rust-anything/api/install'
    const BOOTSTRAP_ROUTE = '/rust-anything/api/bootstrap'
    const TOKEN_ROUTE = '/rust-anything/api/token'

    // Every management route requires Authorization: Bearer <token>. The token is minted by the
    // Host half per Harness process; this page bootstraps it from a route that itself sits behind
    // the DSH connection admission, so no user input is involved. A rotated token (plugin reload)
    // shows up as one 401, which re-bootstraps and retries once.
    let tokenPromise = null
    function fetchToken() {
      if (!tokenPromise) {
        tokenPromise = fetch(TOKEN_ROUTE, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
          .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`token route answered HTTP ${response.status}`))))
          .then((body) => {
            if (!body || typeof body.token !== 'string' || body.token.length < 16) throw new Error('token route returned no token')
            return body.token
          })
          .catch((error) => { tokenPromise = null; throw error })
      }
      return tokenPromise
    }
    function apiFetch(pathname, options = {}) {
      const request = (token) => fetch(pathname, {
        ...options,
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(options.headers || {}), authorization: `Bearer ${token}` },
      })
      return fetchToken().then(request).then((response) => {
        if (response.status !== 401) return response
        tokenPromise = null
        return fetchToken().then(request)
      })
    }
    const getJson = (pathname) => apiFetch(pathname).then((response) => response.json())
    const postJson = (pathname, body) => apiFetch(pathname, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((response) => response.json())

    const STATUS_REFRESH_MS = 120_000
    const BOARD_REFRESH_MS = 30_000
    const INSTALL_POLL_MS = 1_500

    // --- language --------------------------------------------------------------------------
    const STR = {
      zh: {
        title: 'Rust Anything',
        sub: '一块一块把应用改写成 Rust，每一步都用原来的录制行为验证',
        lang: '中文',
        langOther: 'EN',
        status: 'CLI 与项目',
        notInstalled: '未安装',
        installed: '已安装',
        binary: '二进制',
        root: '安装根目录',
        version: '版本',
        skill: '工作流 skill',
        project: '项目',
        projectNoSession: '（进程目录 · 无会话上下文）',
        original: '原语言',
        crates: '已生成的 crate',
        cases: '录制用例',
        exports: '导出函数',
        appCases: '录制用例',
        frontDoor: 'Rust 前门',
        portMap: '端口图',
        none: '未检测到',
        install: '安装 / 更新 CLI',
        envTitle: '环境与依赖',
        envHint: '自动检查本机环境，缺什么就一键装：cargo 走官方 rustup，Windows/Python/JDK/Go/Ruby/PHP/.NET 优先走国内直连镜像，装不了才回退 winget。cc 按 vswhere 判定，agents 永远不装。',
        envRust: '修复 Rust 工具链（cargo + 链接器）',
        envStop: '停止',
        envAll: '全部修复',
        envCheck: '运行诊断',
        envRunning: '安装中…',
        envInstallOne: '装',
        envClean: '诊断没报问题',
        envReadyCount: '项已就绪',
        envTodoCount: '项待装',
        envShowReady: '显示已就绪',
        envHideReady: '只看待装',
        envOutdated: '版本过低',
        envLarge: '大文件',
        envStale: '上一次安装被外部结束（重启或被 kill），下面的日志是它最后的输出',
        doctorTodo: '诊断待处理（环境卡里逐项处理）',
        envStill: '仍缺少',
        envReady: '已就绪',
        envSkip: '不装',
        envFixPath: '改 PATH',
        installing: '正在安装…',
        installHint: '从官方 release 下载并校验 SHA256，然后让 MCP 桥重连到新二进制',
        doctor: '运行诊断',
        doctorOff: '未运行',
        surface: '工具面',
        surfaceShort: '工具面',
        surfaceHint: '决定这一轮对话里 mcp__rust_anything__* 有多少个工具',
        board: '端口看板',
        boardHint: '由 rust-anything map --json 生成，只读',
        boardEmpty: '还没有端口：先在项目里跑 analyze，或者让 agent 分析这个仓库',
        refresh: '刷新',
        units: '单元',
        crate: 'crate',
        state: '状态',
        changed: '上游已改，需要重新录制',
        off: '关闭',
        plan: '规划',
        port: '移植',
        all: '全部',
        custom: '自定义',
        error: '出错了',
      },
      en: {
        title: 'Rust Anything',
        sub: 'Rewrite the app in Rust one piece at a time, every step checked against recorded behavior',
        lang: 'EN',
        langOther: '中文',
        status: 'CLI & project',
        notInstalled: 'not installed',
        installed: 'installed',
        binary: 'binary',
        root: 'install root',
        version: 'version',
        skill: 'workflow skill',
        project: 'project',
        projectNoSession: ' (process dir, no session)',
        original: 'original language',
        crates: 'crates',
        cases: 'recorded cases',
        exports: 'exports',
        app: 'whole app',
        appCases: 'cases',
        frontDoor: 'Rust front door',
        portMap: 'port map',
        none: 'none detected',
        install: 'Install / update CLI',
        envTitle: 'Environment',
        envHint: 'What doctor flags, installed from here: cargo from the official rustup, the heavy packages from CN mirrors first and winget only as a fallback. cc is decided by vswhere; agents are never installed.',
        envRust: 'Fix the Rust toolchain (cargo + linker)',
        envStop: 'Stop',
        envAll: 'Fix everything',
        envCheck: 'Run doctor',
        envRunning: 'installing…',
        envInstallOne: 'install',
        envClean: 'doctor reports nothing missing',
        envReadyCount: 'ready',
        envTodoCount: 'to install',
        envShowReady: 'show ready',
        envHideReady: 'only missing',
        envOutdated: 'outdated',
        envLarge: 'large download',
        envStale: 'the last install was killed from outside; the log below is its last output',
        doctorTodo: 'doctor pending (handled in the Environment card)',
        envStill: 'still missing',
        envReady: 'ready',
        envSkip: 'n/a',
        envFixPath: 'fix PATH',
        installing: 'installing…',
        installHint: 'Downloads the official release, verifies SHA256, then reconnects the MCP bridge',
        doctor: 'Run doctor',
        doctorOff: 'not run',
        surface: 'Tool surface',
        surfaceShort: 'tools',
        surfaceHint: 'How many mcp__rust_anything__* tools this session carries',
        board: 'Port board',
        boardHint: 'From rust-anything map --json; read-only',
        boardEmpty: 'No port yet: run analyze in the project, or ask the agent to analyze this repo',
        refresh: 'Refresh',
        units: 'units',
        crate: 'crate',
        state: 'state',
        changed: 'changed upstream, re-record',
        off: 'Off',
        plan: 'Plan',
        port: 'Port',
        all: 'All',
        custom: 'Custom',
        error: 'error',
      },
    }
    const LANG_KEY = 'dsh-rust-anything/lang'
    const langState = { value: 'zh', listeners: new Set() }
    try {
      const stored = localStorage.getItem(LANG_KEY)
      if (stored === 'zh' || stored === 'en') langState.value = stored
    } catch { /* private mode */ }
    function setLang(next) {
      langState.value = next
      try { localStorage.setItem(LANG_KEY, next) } catch { /* ignore */ }
      for (const listener of langState.listeners) listener(next)
    }
    function useStrings() {
      const [lang, set] = React.useState(langState.value)
      React.useEffect(() => {
        langState.listeners.add(set)
        return () => langState.listeners.delete(set)
      }, [])
      return [lang, STR[lang] || STR.zh]
    }

    // --- icon ------------------------------------------------------------------------------
    function RustIcon(props) {
      const size = (props && props.size) || 22
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true' },
        h('circle', { cx: 12, cy: 12, r: 9.2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, opacity: 0.55 }),
        h('path', { d: 'M7.2 8.1v5.1a4.8 4.8 0 0 0 9.6 0V8.1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' }),
        h('path', { d: 'M8.6 12.2h6.8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', opacity: 0.8 }),
        h('circle', { cx: 18.3, cy: 6.1, r: 1.35, fill: 'currentColor', opacity: 0.9 }))
    }

    function LangSwitch(props) {
      const [lang, s] = useStrings()
      return h('button', {
        type: 'button',
        className: 'dsh-ra-btn dsh-ra-lang',
        title: props && props.title ? props.title : '',
        onClick: () => setLang(lang === 'zh' ? 'en' : 'zh'),
      }, s.langOther)
    }

    // --- surface chip ----------------------------------------------------------------------
    const TIERS = ['off', 'plan', 'port', 'all']

    function tierLabel(tier, s) {
      if (tier === 'off') return s.off
      if (tier === 'plan') return s.plan
      if (tier === 'port') return s.port
      if (tier === 'all') return s.all
      return s.custom
    }

    function SurfaceChip() {
      // A throwing slot render disappears silently in the host; show the reason instead.
      try {
        return SurfaceChipInner() 
      } catch (error) {
        return h('span', { style: { fontSize: '11px', color: '#e06060' } }, 'RA: ' + String(error && error.message ? error.message : error))
      }
    }

    function SurfaceChipInner() {
      const [, s] = useStrings()
      const [state, setState] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const load = React.useCallback((force = false) => {
        getJson(SURFACE_ROUTE).then((body) => setState(body)).catch(() => setState({ surface: 'unknown' }))
      }, [])
      React.useEffect(() => {
        load()
        const timer = setInterval(load, 20_000)
        return () => clearInterval(timer)
      }, [load])
      const surface = state && state.surface ? state.surface : 'all'
      const tools = state && state.mcpTools ? state.mcpTools : null
      const pick = (tier) => {
        setOpen(false)
        postJson(SURFACE_ROUTE, { surface: tier }).then((body) => setState(body)).catch(() => {})
      }
      return h('div', { className: 'dsh-ra-chip-wrap' },
        h('button', {
          type: 'button',
          // Same visual language as the tier buttons in the environment card: the active tier is an
          // accent-tinted chip, "off" is muted — a bare outline here read as decoration.
          className: `dsh-ra-chip${surface === 'off' ? ' is-off' : ' is-on'}${open ? ' is-open' : ''}`,
          title: s.surfaceHint,
          onClick: () => setOpen((value) => !value),
        },
        h('span', { className: 'dsh-ra-chip-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'dsh-ra-chip-label' }, s.surfaceShort),
        h('span', { className: 'dsh-ra-chip-tier' }, tierLabel(surface, s)),
        tools ? h('span', { className: 'dsh-ra-chip-count' }, `${tools.visible}/${tools.total}`) : null,
        h('span', { className: `dsh-ra-caret${open ? ' is-open' : ''}`, 'aria-hidden': 'true' }, '▾')),
        open ? h('div', { className: 'dsh-ra-menu' },
          TIERS.map((tier) => h('button', {
            key: tier,
            type: 'button',
            className: `dsh-ra-menu-item${tier === surface ? ' is-on' : ''}`,
            onClick: () => pick(tier),
          }, tierLabel(tier, s)))) : null)
    }

    // --- cards -----------------------------------------------------------------------------
    function Row(props) {
      return h('div', { className: 'dsh-ra-row' },
        h('span', { className: 'dsh-ra-key' }, props.label),
        h('span', { className: 'dsh-ra-val', title: props.title || '' }, props.value))
    }

    function StatusCard(props) {
      const { data, s, onInstall, busy, onDoctor } = props
      const project = (data && data.project) || {}
      const languages = (project.languages && project.languages.length) ? project.languages.join(', ') : s.none
      const crates = project.crates || []
      const cratesText = crates.length
        ? crates.map((crate) => `${crate.crate} · ${crate.exports} ${s.exports} · ${crate.cases === null ? '?' : crate.cases} ${s.cases}`).join('  |  ')
        : s.none
      return h('section', { className: 'dsh-ra-card' },
        h('header', { className: 'dsh-ra-card-head' },
          h('h2', null, s.status),
          h('span', { className: `dsh-ra-badge${data && data.installed ? ' is-ok' : ' is-warn'}` },
            data && data.installed ? `${s.installed}${data.version ? ` · ${data.version}` : ''}` : s.notInstalled)),
        h(Row, { label: s.binary, value: (data && data.cliPath) || '—', title: (data && data.cliPath) || '' }),
        h(Row, { label: s.root, value: (data && data.root) || '—', title: (data && data.root) || '' }),
        h(Row, { label: s.skill, value: data && data.skill && data.skill.installed ? data.skill.dir : s.notInstalled }),
        // An HTTP request carries no session, so the page can only report the harness process
        // directory; label that instead of passing it off as the project.
        h(Row, {
          label: s.project,
          value: data && data.projectSource === 'cwd' && project.root ? `${project.root} ${s.projectNoSession}` : project.root || '—',
          title: project.root || '',
        }),
        h(Row, { label: s.original, value: languages }),
        h(Row, { label: s.crates, value: cratesText, title: crates.map((crate) => crate.dir).join('\n') }),
        project.app ? h(Row, { label: s.app, value: `${project.app.cases} ${s.appCases}${project.app.frontDoor ? ` · ${s.frontDoor}` : ''}` }) : null,
        project.portMap ? h(Row, { label: s.portMap, value: project.portMap.mtime }) : null,
        h('div', { className: 'dsh-ra-actions' },
          h('button', {
            type: 'button',
            className: 'dsh-ra-btn is-primary',
            disabled: Boolean(busy),
            onClick: onInstall,
          }, busy ? s.installing : s.install)),
        h('p', { className: 'dsh-ra-note' }, s.installHint),
        // The environment card is the place that lists checks. Here a one-line pointer is enough, and
        // it never prints doctor's `fix` text: for `agents` that text is `rust-anything setup
        // --agent claude`, which configures a different agent entirely.
        data && data.doctor
          ? h('p', { className: 'dsh-ra-note' }, (() => {
            const checks = Array.isArray(data.doctor.checks) ? data.doctor.checks : []
            if (!checks.length) return data.doctor.error || s.envCheck
            const todo = checks.filter((check) => check.status !== 'ok' && check.installable !== false)
            return todo.length ? `${s.doctorTodo}: ${todo.map((check) => check.name).join(' · ')}` : s.envClean
          })())
          : null,
        data && data.install && data.install.output && data.install.output.length
          ? h('pre', { className: 'dsh-ra-log' }, data.install.output.slice(-14).join('\n'))
          : null,
        data && data.notes && data.notes.length
          ? h('ul', { className: 'dsh-ra-notes' }, data.notes.map((note, index) => h('li', { key: index }, note)))
          : null)
    }

    // Which kind of project needs which check. The list is long because rust-anything supports six
    // source languages; a TypeScript port needs exactly one row of it.
    const CHECK_NEEDS = {
      cargo: '所有 Rust 构建',
      cc: '所有 Rust 构建',
      node: 'TS/JS 项目',
      python3: 'Python 项目',
      go: 'Go 项目',
      ruby: 'Ruby 项目',
      java: 'Java 项目',
      javac: 'Java 项目',
      php: 'PHP · 仅 app 通道',
      dotnet: 'C# · 仅 app 通道',
      'wasm-bindgen': 'wasm 桥',
      'wasm32-unknown-unknown': 'wasm 桥',
      kotlinc: 'Kotlin 项目',
      'Android NDK': 'Android 项目',
      'Android Rust targets': 'Android 项目',
      agents: '不需要',
      'mcp server': '插件自带',
    }

    // Cheap identity for a job: re-render only when something a human can see actually changed.
    function jobSignature(job) {
      if (!job) return ''
      return [job.running, job.stale, job.ok, job.startedAt, (job.output || []).length, (job.items || []).length].join('|')
    }

    function toneOf(check) {
      if (check.status === 'ok') return 'ok'
      if (check.suggested === 'skip') return 'skip'
      if (check.status === 'outdated') return 'warn'
      return 'bad'
    }

    function EnvRow(props) {
      const { check, s, running, onInstall } = props
      const tone = toneOf(check)
      const canAct = check.installable && check.suggested !== 'skip'
      const detail = [check.detail, check.note].filter(Boolean).join(' · ')
      return h('div', { className: `dsh-ra-envrow is-${tone}` },
        h('span', { className: `dsh-ra-dot is-${tone}`, 'aria-hidden': 'true' }),
        h('div', { className: 'dsh-ra-envmain' },
          h('div', { className: 'dsh-ra-envname' },
            h('span', null, check.name),
            CHECK_NEEDS[check.name] ? h('span', { className: 'dsh-ra-tag' }, CHECK_NEEDS[check.name]) : null,
            check.status === 'ok' ? h('span', { className: 'dsh-ra-tag is-ok' }, s.envReady) : null,
            check.status === 'outdated' ? h('span', { className: 'dsh-ra-tag is-warn' }, s.envOutdated) : null,
            check.weight === 'large' && check.status !== 'ok' ? h('span', { className: 'dsh-ra-tag is-warn' }, s.envLarge) : null),
          h('div', { className: 'dsh-ra-envdetail', title: detail }, detail || check.status)),
        canAct
          ? h('button', {
            type: 'button',
            className: 'dsh-ra-btn',
            disabled: running,
            title: check.note || check.detail || '',
            onClick: () => onInstall([check.name]),
          }, check.suggested === 'fixpath' ? s.envFixPath : s.envInstallOne)
          : h('span', { className: 'dsh-ra-envskip', title: check.note || '' }, check.suggested === 'skip' ? s.envSkip : ''))
    }

    function EnvCard(props) {
      const { s } = props
      const [doctor, setDoctor] = React.useState(null)
      const [job, setJob] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [showReady, setShowReady] = React.useState(false)
      // One probe at a time, and never replace a loaded doctor payload with nothing: `doctor` spawns
      // the CLI, so a slower second request used to blank the summary line for a frame — that is the
      // flicker seen right above the list.
      const inflight = React.useRef(false)
      const load = React.useCallback((force = false) => {
        if (inflight.current) return Promise.resolve(null)
        inflight.current = true
        return getJson(`${STATUS_ROUTE}?doctor=1`)
          .then((body) => {
            const next = body && body.doctor ? body.doctor : null
            if (next && Array.isArray(next.checks) && next.checks.length) setDoctor(next)
            const last = body && body.bootstrap && body.bootstrap.lastJob ? body.bootstrap.lastJob : null
            if (last) setJob(last)
            return body
          })
          .catch(() => null)
          .finally(() => { inflight.current = false })
      }, [])
      React.useEffect(() => { load() }, [load])
      React.useEffect(() => {
        if (!busy && !(job && job.running)) return undefined
        // Polling is what makes a running install look alive, but replacing the state object on every
        // tick re-renders the card (and its log) even when nothing changed — that is the flicker.
        const timer = setInterval(() => {
          getJson(BOOTSTRAP_ROUTE).then((body) => {
            const current = body && body.job ? body.job : null
            if (!current) return
            setJob((previous) => (jobSignature(previous) === jobSignature(current) ? previous : current))
            if (current.running === false) {
              setBusy((value) => (value ? false : value))
              load()
            }
          }).catch(() => {})
        }, 3000)
        return () => clearInterval(timer)
      }, [busy, job, load])
      const start = (body) => {
        setBusy(true)
        setJob(null)
        postJson(BOOTSTRAP_ROUTE, body).then(() => {}).catch(() => setBusy(false))
      }
      const checks = doctor && Array.isArray(doctor.checks) ? doctor.checks : []
      const ready = checks.filter((check) => check.status === 'ok')
      const todo = checks.filter((check) => check.status !== 'ok')
      const actionable = todo.filter((check) => check.installable && check.suggested !== 'skip')
      const running = busy || Boolean(job && job.running && !job.stale)
      // A run that only re-checked and installed nothing leaves a log that reads like a failure
      // notice ("probe failed", "bootstrap finished"); keep the log for runs that did something.
      const didWork = Boolean(job && (job.running
        || (job.items || []).some((item) => item.status === 'installed' || item.status === 'failed' || item.status === 'fixed')))
      const rows = showReady ? checks : todo
      return h('section', { className: 'dsh-ra-card' },
        h('header', { className: 'dsh-ra-card-head' },
          h('h2', null, s.envTitle),
          h('button', { type: 'button', className: 'dsh-ra-btn', onClick: () => load(true) }, s.envCheck)),
        h('p', { className: 'dsh-ra-note' }, s.envHint),
        checks.length
          ? h('div', { className: 'dsh-ra-envsum' },
            h('span', { className: 'dsh-ra-dot is-ok' }), h('span', null, `${ready.length} ${s.envReadyCount}`),
            h('span', { className: 'dsh-ra-dot is-bad' }), h('span', null, `${actionable.length} ${s.envTodoCount}`),
            ready.length ? h('button', {
              type: 'button',
              className: 'dsh-ra-btn dsh-ra-mini',
              onClick: () => setShowReady((value) => !value),
            }, showReady ? s.envHideReady : s.envShowReady) : null)
          : null,
        // Only worth saying when the interrupted run left something broken; a stale marker alone is
        // noise once the environment is healthy.
        job && job.stale && (job.items || []).some((item) => item.status === 'failed')
          ? h('p', { className: 'dsh-ra-note is-warn' }, s.envStale)
          : null,
        doctor
          ? (rows.length === 0
            ? h('p', { className: 'dsh-ra-ok' }, s.envClean)
            : h('div', { className: 'dsh-ra-envlist' },
              rows.map((check) => h(EnvRow, {
                key: check.name,
                check,
                s,
                running,
                onInstall: (ids) => start({ ids }),
              }))))
          : h('p', { className: 'dsh-ra-note' }, s.envCheck),
        h('div', { className: 'dsh-ra-actions' },
          h('button', { type: 'button', className: 'dsh-ra-btn is-primary', disabled: running, onClick: () => start({ plan: 'rust' }) }, running ? s.envRunning : s.envRust),
          h('button', { type: 'button', className: 'dsh-ra-btn', disabled: running, onClick: () => start({ plan: 'all' }) }, s.envAll),
          running
            ? h('button', {
              type: 'button',
              className: 'dsh-ra-btn is-stop',
              onClick: () => {
                // The host aborts the job: it kills the curl/cargo child and settles the state.
                postJson(BOOTSTRAP_ROUTE, { cancel: true }).then(() => setBusy(false)).catch(() => {})
              },
            }, s.envStop)
            : null),
        didWork && job.output && job.output.length
          ? h('pre', { className: 'dsh-ra-log is-fixed' }, job.output.slice(-12).join('\n'))
          : null,
        // A job's post-run summary describes the machine as it was *then*. Once the job is stale (the
        // app restarted, PATH has since been fixed) the line contradicts the rows above it, so drop it.
        job && !job.stale && job.doctorAfter && job.doctorAfter.stillMissing && job.doctorAfter.stillMissing.length
          ? h('p', { className: 'dsh-ra-note' }, `${s.envStill}: ${job.doctorAfter.stillMissing.join(', ')}`)
          : null)
    }

    function boardRows(json) {
      if (!json || typeof json !== 'object') return null
      const lists = [json.units, json.port_map && json.port_map.units, json.pieces, json.app && json.app.units]
      const units = lists.find((value) => Array.isArray(value))
      if (!units) return null
      return units.map((unit, index) => {
        const id = unit.id || unit.unit || unit.name || `#${index + 1}`
        const crate = unit.crate || unit.crate_name || unit.crateDir || (unit.port && unit.port.crate) || ''
        const cases = unit.cases !== undefined ? unit.cases : (unit.recorded_cases !== undefined ? unit.recorded_cases : null)
        let state = unit.state || unit.status || ''
        if (!state) {
          if (unit.ported === true || unit.lifted === true) state = 'ported'
          else if (unit.bridged === true || crate) state = 'bridged'
          else if (unit.keep === true || unit.blocked === true) state = 'keep'
          else state = 'planned'
        }
        const changed = unit.changed_upstream === true || unit.changedUpstream === true
        return { key: String(id) + index, id: String(id), crate: String(crate || ''), cases, state: String(state), changed }
      })
    }

    function BoardCard(props) {
      const { board, s, onRefresh } = props
      const rows = board && board.ok ? boardRows(board.json) : null
      const changed = board && board.ok && board.json
        ? (Array.isArray(board.json.changed_upstream) ? board.json.changed_upstream : (Array.isArray(board.json.changedUpstream) ? board.json.changedUpstream : []))
        : []
      return h('section', { className: 'dsh-ra-card' },
        h('header', { className: 'dsh-ra-card-head' },
          h('h2', null, s.board),
          h('button', { type: 'button', className: 'dsh-ra-btn', onClick: onRefresh }, s.refresh)),
        h('p', { className: 'dsh-ra-note' }, s.boardHint),
        board && board.error ? h('p', { className: 'dsh-ra-error' }, `${s.error}: ${board.error}`) : null,
        rows && rows.length
          ? h('div', { className: 'dsh-ra-table' },
            h('div', { className: 'dsh-ra-thead' },
              h('span', null, s.units), h('span', null, s.crate), h('span', null, s.cases), h('span', null, s.state)),
            rows.slice(0, 60).map((row) => h('div', { key: row.key, className: `dsh-ra-trow${row.changed ? ' is-changed' : ''}` },
              h('span', { title: row.id }, row.id),
              h('span', { title: row.crate }, row.crate || '—'),
              h('span', null, row.cases === null || row.cases === undefined ? '—' : String(row.cases)),
              h('span', null, row.state))))
          : h('p', { className: 'dsh-ra-note' }, board && board.text ? board.text.slice(0, 1200) : s.boardEmpty),
        changed.length
          ? h('div', { className: 'dsh-ra-changed' },
            h('strong', null, `${s.changed} (${changed.length})`),
            h('ul', null, changed.slice(0, 12).map((item, index) => h('li', { key: index }, typeof item === 'string' ? item : JSON.stringify(item)))))
          : null,
        board && board.ok && board.json && !rows
          ? h('details', null, h('summary', null, 'map --json'), h('pre', { className: 'dsh-ra-log' }, JSON.stringify(board.json, null, 2).slice(0, 8000)))
          : null)
    }

    function SurfaceCard(props) {
      const { surface, s, onPick } = props
      const current = surface && surface.surface ? surface.surface : 'unknown'
      const tools = surface && surface.mcpTools ? surface.mcpTools : null
      return h('section', { className: 'dsh-ra-card' },
        h('header', { className: 'dsh-ra-card-head' },
          h('h2', null, s.surface),
          tools ? h('span', { className: 'dsh-ra-badge' }, `${tools.visible} / ${tools.total}`) : null),
        h('p', { className: 'dsh-ra-note' }, s.surfaceHint),
        h('div', { className: 'dsh-ra-tiers' },
          TIERS.map((tier) => h('button', {
            key: tier,
            type: 'button',
            className: `dsh-ra-btn${tier === current ? ' is-primary' : ''}`,
            onClick: () => onPick(tier),
          }, tierLabel(tier, s)))),
        surface && surface.allow && surface.allow.length
          ? h('p', { className: 'dsh-ra-note' }, `allow: ${surface.allow.join(', ')}`)
          : null)
    }

    // --- page ------------------------------------------------------------------------------
    const css = `
.dsh-ra-page { padding: 20px 22px 40px; color: var(--dsh-text, #e6e6e6); font-size: 13px; height: 100%; overflow-y: auto; overscroll-behavior: contain; }
.dsh-ra-page::-webkit-scrollbar { width: 10px; }
.dsh-ra-page::-webkit-scrollbar-thumb { background: color-mix(in srgb, currentColor 22%, transparent); border-radius: 5px; }
.dsh-ra-page::-webkit-scrollbar-track { background: transparent; }
.dsh-ra-inner { max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.dsh-ra-head { display: flex; align-items: center; gap: 12px; margin-bottom: 4px; }
.dsh-ra-mark { display: flex; align-items: center; justify-content: center; width: 38px; height: 38px; border-radius: 11px;
  background: color-mix(in srgb, currentColor 10%, transparent); color: var(--dsh-accent, #e2862a); }
.dsh-ra-head-main { flex: 1 1 auto; min-width: 0; }
.dsh-ra-title { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .2px; }
.dsh-ra-sub { margin: 2px 0 0; font-size: 12px; opacity: .65; }
.dsh-ra-card { border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 12px; padding: 14px 16px;
  background: color-mix(in srgb, currentColor 3%, transparent); }
.dsh-ra-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.dsh-ra-card-head h2 { margin: 0; font-size: 13px; font-weight: 600; letter-spacing: .3px; text-transform: none; opacity: .9; }
.dsh-ra-row { display: grid; grid-template-columns: 132px 1fr; gap: 8px; padding: 3px 0; align-items: baseline; }
.dsh-ra-key { opacity: .55; }
.dsh-ra-val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.dsh-ra-badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); opacity: .85; }
.dsh-ra-badge.is-ok { color: #4ac26b; border-color: color-mix(in srgb, #4ac26b 45%, transparent); }
.dsh-ra-badge.is-warn { color: #e0a13a; border-color: color-mix(in srgb, #e0a13a 45%, transparent); }
.dsh-ra-actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.dsh-ra-btn { font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 8px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent); background: transparent; color: inherit; opacity: .9; }
.dsh-ra-btn:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-ra-btn[disabled] { opacity: .45; cursor: default; }
.dsh-ra-btn.is-primary { border-color: color-mix(in srgb, var(--dsh-accent, #e2862a) 55%, transparent);
  background: color-mix(in srgb, var(--dsh-accent, #e2862a) 14%, transparent); color: inherit; }
.dsh-ra-note { margin: 8px 0 0; font-size: 11.5px; opacity: .6; line-height: 1.5; }
.dsh-ra-checks, .dsh-ra-notes { margin: 8px 0 0; padding-left: 18px; font-size: 11.5px; opacity: .75; line-height: 1.6; }
.dsh-ra-checks .is-req { color: #e0a13a; }
.dsh-ra-log.is-fixed { height: 120px; }
.dsh-ra-log { margin: 10px 0 0; padding: 9px 11px; border-radius: 8px; max-height: 220px; overflow: auto;
  background: color-mix(in srgb, currentColor 6%, transparent); font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
.dsh-ra-error { color: #e06060; font-size: 11.5px; }
.dsh-ra-table { margin-top: 10px; display: flex; flex-direction: column; gap: 2px; }
.dsh-ra-thead, .dsh-ra-trow { display: grid; grid-template-columns: 1.4fr 1.2fr 70px 90px; gap: 8px; padding: 4px 6px; border-radius: 6px; }
.dsh-ra-thead { font-size: 10.5px; text-transform: uppercase; letter-spacing: .5px; opacity: .45; }
.dsh-ra-trow { font-size: 12px; background: color-mix(in srgb, currentColor 4%, transparent); }
.dsh-ra-trow span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ra-trow.is-changed { background: color-mix(in srgb, #e0a13a 12%, transparent); }
.dsh-ra-envlist { display: flex; flex-direction: column; gap: 6px; min-height: 72px; max-height: 46vh; overflow-y: auto; padding-right: 4px; margin-top: 4px; }
.dsh-ra-envrow { display: grid; grid-template-columns: 10px 1fr auto; gap: 10px; align-items: center; padding: 7px 10px; border-radius: 8px; background: color-mix(in srgb, currentColor 4%, transparent); }
.dsh-ra-envrow.is-skip { opacity: .55; }
.dsh-ra-envname { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; }
.dsh-ra-envdetail { font-size: 11px; opacity: .55; margin-top: 3px; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ra-envskip { font-size: 11px; opacity: .4; }
.dsh-ra-tag { font-size: 10px; opacity: .45; }
.dsh-ra-tag.is-ok { color: #4ac26b; opacity: .9; }
.dsh-ra-tag.is-warn { color: #e0a13a; opacity: .9; }
.dsh-ra-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: #888; }
.dsh-ra-dot.is-ok { background: #4ac26b; }
.dsh-ra-dot.is-warn { background: #e0a13a; }
.dsh-ra-dot.is-bad { background: #e06060; }
.dsh-ra-dot.is-skip { background: #666; }
.dsh-ra-envsum { display: flex; align-items: center; gap: 6px; font-size: 11.5px; opacity: .8; margin: 10px 0 6px; flex-wrap: wrap; }
.dsh-ra-envsum .dsh-ra-dot { margin-left: 8px; }
.dsh-ra-mini { font-size: 11px; padding: 2px 8px; margin-left: 6px; }
.dsh-ra-btn.is-stop { border-color: color-mix(in srgb, #e06060 55%, transparent); color: color-mix(in srgb, #e06060 78%, currentColor); }
.dsh-ra-note.is-warn { color: #e0a13a; opacity: .9; }
.dsh-ra-ok { margin: 10px 0 0; font-size: 11.5px; color: #4ac26b; }
.dsh-ra-changed { margin-top: 12px; font-size: 11.5px; }
.dsh-ra-changed ul { margin: 4px 0 0; padding-left: 18px; opacity: .8; }
.dsh-ra-tiers { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }
.dsh-ra-chip-wrap { position: relative; display: inline-flex; }
.dsh-ra-chip { appearance: none; -webkit-appearance: none; display: inline-flex; align-items: center; gap: 6px;
  border: 1px solid var(--dsw-alias-border-l2); box-shadow: none; background: transparent;
  color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 1;
  padding: 5px 9px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.dsh-ra-chip:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-ra-chip.is-open { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-ra-chip.is-off { opacity: .6; }
.dsh-ra-chip.is-off:hover { opacity: .85; }
.dsh-ra-chip-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); flex: none; }
.dsh-ra-chip.is-off .dsh-ra-chip-dot { background: var(--dsw-alias-state-idle-primary); }
.dsh-ra-chip-label { opacity: .8; }
.dsh-ra-chip-tier { font-weight: 600; }
.dsh-ra-chip-count { opacity: .55; font-variant-numeric: tabular-nums; }
.dsh-ra-caret { font-size: 9px; opacity: .7; line-height: 1; transition: transform .12s ease; }
.dsh-ra-caret.is-open { transform: rotate(180deg); }
.dsh-ra-dim { opacity: .5; }
.dsh-ra-menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 40; min-width: 132px; padding: 5px;
  border-radius: 9px; border: 1px solid color-mix(in srgb, currentColor 20%, transparent);
  background: var(--dsh-surface, rgba(28,28,30,.98)); box-shadow: 0 8px 26px rgba(0,0,0,.35); display: flex; flex-direction: column; }
.dsh-ra-menu-item { font: inherit; font-size: 12px; text-align: left; padding: 6px 9px; border-radius: 6px;
  border: 0; background: transparent; color: inherit; cursor: pointer; }
.dsh-ra-menu-item:hover { background: color-mix(in srgb, currentColor 9%, transparent); }
.dsh-ra-menu-item.is-on { background: color-mix(in srgb, var(--dsh-accent, #e2862a) 20%, transparent); }
`

    // The composer chip already reports its own failure; the page needs the same, otherwise a render
    // error leaves an empty panel with nothing to act on.
    function RustPageBoundary() {
      try {
        return RustPage()
      } catch (error) {
        const message = String(error && error.message ? error.message : error)
        return h('div', { className: 'dsh-ra-page' },
          h('div', { className: 'dsh-ra-inner' },
            h('section', { className: 'dsh-ra-card' },
              h('h2', null, 'Rust Anything'),
              h('p', { className: 'dsh-ra-error' }, 'RA page: ' + message),
              h('p', { className: 'dsh-ra-note' }, 'Reload the page. If it persists the client bundle is broken; the four ra_* tools still work from the conversation.'))))
      }
    }

    function RustPage() {
      const [, s] = useStrings()
      const [status, setStatus] = React.useState(null)
      const [board, setBoard] = React.useState(null)
      const [surface, setSurface] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)

      const loadStatus = React.useCallback((doctor) => {
        const query = doctor === 'force' ? '?doctor=1&refresh=1' : ''
        return getJson(STATUS_ROUTE + query)
          .then((body) => { setStatus(body); setError(null); return body })
          .catch((failure) => { setError(String(failure && failure.message ? failure.message : failure)) })
      }, [])
      const loadBoard = React.useCallback(() => {
        getJson(BOARD_ROUTE).then((body) => setBoard(body)).catch(() => setBoard({ ok: false, error: 'board route failed' }))
      }, [])
      const loadSurface = React.useCallback(() => {
        getJson(SURFACE_ROUTE).then((body) => setSurface(body)).catch(() => {})
      }, [])

      React.useEffect(() => {
        loadStatus()
        loadBoard()
        loadSurface()
        const statusTimer = setInterval(() => loadStatus(), STATUS_REFRESH_MS)
        const boardTimer = setInterval(() => loadBoard(), BOARD_REFRESH_MS)
        return () => { clearInterval(statusTimer); clearInterval(boardTimer) }
      }, [loadStatus, loadBoard, loadSurface])

      // While an install job runs, poll the cheap status route every 1.5 s and stop when it ends.
      React.useEffect(() => {
        const job = status && status.install
        const running = busy || (job && job.running)
        if (!running) return undefined
        const timer = setInterval(() => {
          getJson(STATUS_ROUTE).then((body) => {
            setStatus(body)
            if (body && body.install && body.install.running === false) {
              setBusy(false)
              loadBoard()
            }
          }).catch(() => {})
        }, INSTALL_POLL_MS)
        return () => clearInterval(timer)
      }, [busy, status, loadBoard])

      const onInstall = () => {
        setBusy(true)
        postJson(INSTALL_ROUTE, { version: 'latest' })
          .then(() => loadStatus())
          .catch((failure) => { setBusy(false); setError(String(failure && failure.message ? failure.message : failure)) })
      }
      const onDoctor = () => loadStatus('force')
      const onPick = (tier) => {
        postJson(SURFACE_ROUTE, { surface: tier }).then((body) => setSurface(body)).catch(() => {})
      }

      return h('div', { className: 'dsh-ra-page', 'data-dsh-rust-anything': 'page' },
        h('style', null, css),
        h('div', { className: 'dsh-ra-inner' },
          h('header', { className: 'dsh-ra-head' },
            h('div', { className: 'dsh-ra-mark' }, h(RustIcon, { size: 26 })),
            h('div', { className: 'dsh-ra-head-main' },
              h('h1', { className: 'dsh-ra-title' }, s.title),
              h('p', { className: 'dsh-ra-sub' }, s.sub)),
            h('div', { className: 'dsh-ra-head-side' }, h(LangSwitch, {}))),
          error ? h('p', { className: 'dsh-ra-error' }, `${s.error}: ${error}`) : null,
          h(StatusCard, { data: status, s, onInstall, onDoctor, busy }),
          h(EnvCard, { s }),
          h(BoardCard, { board, s, onRefresh: loadBoard }),
          h(SurfaceCard, { surface, s, onPick })))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The composer chip lives outside the Rust Anything page, so a <style> rendered inside that
        // page never reaches it: the chip used to fall back to browser defaults (menu in flow, no
        // accent). Install the stylesheet once, on the document, when the plugin loads.
        try {
          if (typeof document !== 'undefined' && !document.getElementById('dsh-rust-anything-styles')) {
            const style = document.createElement('style')
            style.id = 'dsh-rust-anything-styles'
            style.textContent = css
            document.head.appendChild(style)
          }
        } catch { /* a non-DOM host still renders the page with its own <style> below */ }
        const slots = ctx.slots
        slots.inject('sidebar.panellist', () => slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 56,
          label: () => 'Rust Anything',
        }, RustIcon))
        slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, RustPageBoundary))
        slots.inject('conversation.input.left', () => slots.register({
          name: 'conversation.input.left',
          id: `${PANEL_ID}/surface`,
          order: 87,
          label: () => 'Rust Anything',
        }, SurfaceChip))
      },
    }
  },
})