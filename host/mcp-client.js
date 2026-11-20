// dsh-rust-anything — a minimal MCP stdio client, owned by this plugin.
//
// Why this exists: `@deepseek-ai/dsh-mcp-client` is not shipped with the Harness, and a profile
// whose plugins were not installed through pnpm has no copy of it, so a patch row that names it
// cannot resolve (and `dsh plugin` refuses Electron-managed profiles). rust-anything's own server
// speaks a small, documented subset — initialize, tools/list, tools/call, prompts/*, ping,
// notifications/progress, notifications/cancelled, newline-delimited JSON-RPC 2.0 — so this file
// speaks it directly. That makes the plugin one bundle row with no peer dependency, and it still
// registers the tools under the same mcp__rust_anything__* names.
//
// What it deliberately does not do: prompts (the skill covers the workflow), resources, sampling,
// and progress reporting (rust-anything only emits progress when a call carries
// params._meta.progressToken, which we never send).

import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = '2025-06-18'
const CLIENT_INFO = { name: 'dsh-rust-anything', version: '0.1.0' }
const INIT_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 30_000
const DEFAULT_CALL_TIMEOUT_MS = 900_000

/**
 * @param {{cli: string, argv?: string[], cwd?: string, env?: Record<string,string>,
 *          callTimeoutMs?: number, log?: (line: string) => void}} options
 */
export function createRustAnythingClient(options) {
  const { cli } = options
  const argv = Array.isArray(options.argv) && options.argv.length ? options.argv.slice() : ['mcp']
  const callTimeoutMs = Number.isFinite(options.callTimeoutMs) ? options.callTimeoutMs : DEFAULT_CALL_TIMEOUT_MS
  const log = options.log || ((line) => console.error(`[dsh-rust-anything] ${line}`))

  let child = null
  let startedAt = null
  let serverInfo = null
  let nextId = 1
  let buffer = ''
  let stopped = false
  const pending = new Map()
  const listChanged = new Set()
  const down = new Set()

  const send = (message) => {
    if (!child || child.killed) throw new Error('rust-anything MCP server is not running')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  const settle = (id, settleWith) => {
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    if (entry.onAbort && entry.signal) entry.signal.removeEventListener('abort', entry.onAbort)
    settleWith(entry)
  }

  const failAll = (reason) => {
    for (const id of [...pending.keys()]) {
      settle(id, (entry) => entry.reject(new Error(reason)))
    }
  }

  function request(method, params, timeoutMs = LIST_TIMEOUT_MS, signal) {
    const id = nextId++
    const message = { jsonrpc: '2.0', id, method }
    if (params !== undefined) message.params = params
    return new Promise((resolve, reject) => {
      if (stopped || !child) {
        reject(new Error('rust-anything MCP server is not running'))
        return
      }
      const entry = { resolve, reject, method, timer: null, onAbort: null, signal }
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          settle(id, (found) => found.reject(new Error(`${method} timed out after ${timeoutMs} ms`)))
        }, timeoutMs)
        if (entry.timer.unref) entry.timer.unref()
      }
      if (signal) {
        entry.onAbort = () => {
          // Tell the server, then settle: rust-anything flips a per-request flag and the worker
          // sends nothing more for that id.
          try { send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id } }) } catch { /* gone */ }
          settle(id, (found) => found.reject(new Error(`${method} cancelled`)))
        }
        if (signal.aborted) {
          entry.onAbort()
          return
        }
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      pending.set(id, entry)
      try {
        send(message)
      } catch (error) {
        settle(id, (found) => found.reject(error))
      }
    })
  }

  function handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message && message.id !== undefined && message.id !== null && (message.result !== undefined || message.error !== undefined)) {
      const id = message.id
      if (message.error) {
        const error = new Error(String(message.error.message || 'MCP error'))
        error.code = message.error.code
        settle(id, (entry) => entry.reject(error))
      } else {
        settle(id, (entry) => entry.resolve(message.result))
      }
      return
    }
    if (message && typeof message.method === 'string') {
      if (message.method === 'notifications/tools/list_changed') {
        for (const listener of listChanged) {
          try { listener() } catch { /* a listener must not break the reader */ }
        }
      }
      // notifications/message, notifications/progress and anything else are ignored on purpose.
    }
  }

  function attach(proc) {
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) handleLine(line)
      }
    })
    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log(text)
    })
    proc.on('error', (error) => {
      failAll(`rust-anything MCP server failed: ${error && error.message ? error.message : error}`)
      for (const listener of down) {
        try { listener(String(error && error.message ? error.message : error)) } catch { /* ignore */ }
      }
    })
    proc.on('exit', (code, signal) => {
      const reason = `rust-anything MCP server exited (code ${code}, signal ${signal === null ? 'none' : signal})`
      if (!stopped) log(reason)
      failAll(reason)
      if (!stopped) {
        for (const listener of down) {
          try { listener(reason) } catch { /* ignore */ }
        }
      }
    })
  }

  async function start() {
    stopped = false
    child = spawn(cli, argv, {
      cwd: options.cwd || undefined,
      env: Object.assign({}, process.env, options.env || {}),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    startedAt = new Date().toISOString()
    buffer = ''
    attach(child)
    const init = await request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, INIT_TIMEOUT_MS)
    serverInfo = (init && init.serverInfo) || null
    // A notification: rust-anything answers only messages with an id, so this is fire-and-forget.
    try { send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) } catch { /* ignore */ }
    return serverInfo
  }

  async function listTools() {
    const result = await request('tools/list', {}, LIST_TIMEOUT_MS)
    const tools = result && Array.isArray(result.tools) ? result.tools : []
    return tools.filter((tool) => tool && typeof tool.name === 'string')
  }

  /**
   * @param {string} name
   * @param {object} args
   * @param {{signal?: AbortSignal, timeoutMs?: number}} [exec]
   */
  async function callTool(name, args, exec = {}) {
    const params = { name, arguments: args && typeof args === 'object' ? args : {} }
    const result = await request('tools/call', params, exec.timeoutMs || callTimeoutMs, exec.signal)
    const payload = {
      ok: !(result && result.isError === true),
      content: result && Array.isArray(result.content) ? result.content : [],
      structuredContent: result && result.structuredContent !== undefined ? result.structuredContent : null,
    }
    return payload
  }

  function stop() {
    stopped = true
    failAll('rust-anything MCP server stopped')
    if (!child) return
    const proc = child
    child = null
    try { proc.stdin.end() } catch { /* already closed */ }
    // rust-anything's serve loop ends on stdin EOF; a stuck call gets the same chain the CLI's own
    // tooling uses: SIGTERM, a second SIGTERM, SIGKILL, then we stop waiting.
    try { proc.kill('SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { proc.kill('SIGTERM') } catch { /* already gone */ } }, 150).unref?.()
    setTimeout(() => { try { proc.kill('SIGKILL') } catch { /* already gone */ } }, 1200).unref?.()
  }

  return {
    start,
    stop,
    listTools,
    callTool,
    onListChanged: (listener) => { listChanged.add(listener); return () => listChanged.delete(listener) },
    onDown: (listener) => { down.add(listener); return () => down.delete(listener) },
    get state() {
      return {
        running: Boolean(child),
        cli,
        argv,
        cwd: options.cwd || null,
        pid: child ? child.pid : null,
        startedAt,
        serverVersion: serverInfo ? serverInfo.version || null : null,
        pending: pending.size,
      }
    },
  }
}
