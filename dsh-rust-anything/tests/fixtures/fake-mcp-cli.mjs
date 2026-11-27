// A stand-in for `rust-anything mcp`: the same wire shape (newline JSON-RPC 2.0, tools/list with
// name/description/inputSchema, tools/call with content + structuredContent + isError), so the
// plugin's client and its tool registration can be tested with no Rust binary and no DSH.
//
// It also emits one `notifications/tools/list_changed` after the second tools/list, to prove the
// plugin re-lists and re-registers when the server says its tool set changed.

// `go` stands in for a tool a later CLI adds: it is not read-only and not a planning step, so the
// only way it can reach the daily `port` tier is the annotation-driven tiering itself. A hardcoded
// name list is exactly what kept `go` (and `fuzz`/`package`/`enable`/`disable`/`report`) invisible
// once the server moved past 2.1.0.
const TOOLS = [
  ['analyze', true], ['bridge', false], ['refresh', false], ['profile', false], ['map', true],
  ['record', false], ['build', false], ['diff', false], ['bench', false], ['shadow', false], ['gate', false],
  ['app_record', false], ['app_replay', false], ['app_front_door', false], ['app_wire', false], ['app_lift', false],
  ['go', false],
]

let lists = 0

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

process.stdin.setEncoding('utf8')
let buffer = ''
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index)
    buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
    switch (message.method) {
      case 'initialize':
        reply({
          protocolVersion: '2025-06-18',
          capabilities: { tools: {}, prompts: {} },
          serverInfo: { name: 'fake-rust-anything', version: '9.9.9' },
          // The real server ships the migration method here; the plugin lifts it into the system
          // prompt, so the fixture has to carry one for that path to be testable.
          instructions: 'fake method: profile the hot path, record the original behaviour, then port one unit at a time.',
        })
        break
      case 'tools/list':
        lists += 1
        reply({
          tools: TOOLS.map(([name, readOnly]) => ({
            name,
            description: `fake ${name}`,
            // Realistic enough to exercise argument validation: the real server takes a project root,
            // a repo path and a crate, and nothing else.
            inputSchema: {
              type: 'object',
              properties: { root: { type: 'string' }, repo: { type: 'string' }, crate: { type: 'string' } },
              required: [],
            },
            annotations: { readOnlyHint: readOnly },
          })),
        })
        if (lists === 2) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
        break
      case 'tools/call': {
        const name = message.params && message.params.name
        if (name === 'record') {
          reply({ content: [{ type: 'text', text: 'record failed: no crate' }], structuredContent: { code: 'NO_CRATE' }, isError: true })
        } else {
          reply({
            content: [{ type: 'text', text: `called ${name} with ${JSON.stringify(message.params.arguments || {})}` }],
            structuredContent: { name, args: message.params.arguments || {} },
            isError: false,
          })
        }
        break
      }
      case 'ping':
        reply({})
        break
      default:
        if (message.id !== undefined) {
          send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } })
        }
      // notifications (initialized, cancelled) are ignored
    }
  }
})

process.stdin.on('end', () => process.exit(0))
