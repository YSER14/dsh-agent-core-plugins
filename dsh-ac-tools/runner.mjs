/**
 * Tool runner: the child-process half of dsh-ac-tools.
 *
 * Protocol (one JSON line on stdin -> one JSON line on stdout):
 *   in:  { mode: 'describe' }                                 -> out: { ok: true, tools: [meta...] }
 *   in:  { mode: 'call', url, name, input, toolCallId }       -> out: { ok: true, output } | { ok: false, error }
 *   in:  { mode: 'shutdown' }                                 -> exits
 *
 * Rules mirrored from agent-core's tool-process.js:
 * - This file must never import anything. It is spawned with
 *   `node runner.mjs`, reads one request from stdin, and exits.
 * - Tool files are loaded by absolute file:// URL, so relative imports
 *   inside a tool file resolve against the tool file's own directory.
 * - Streaming: console.log and yielded chunks of `async *execute` are
 *   forwarded as NDJSON progress lines prefixed with '#', so the parent
 *   can relay them without breaking the single final JSON line.
 */

const encoder = new TextEncoder()
const BLOCK = new Set(['text', 'json', 'error-text'])

/** Emit a progress line (streamed output) without breaking the final JSON line. */
function report(stream, data) {
  process.stdout.write(encoder.encode('#' + JSON.stringify({ stream, data: String(data) }) + '\n'))
}

for (const name of ['log', 'info', 'warn', 'error']) {
  const original = console[name].bind(console)
  console[name] = (...args) => {
    report(name, args.map(v => (typeof v === 'string' ? v : safeInspect(v))).join(' '))
  }
}

function safeInspect(value) {
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

/** Convert a return value into a model-readable output block (mirrors agent-core shape()). */
function shape(result) {
  const value = result?.output ?? result
  if (result && typeof result === 'object' && BLOCK.has(result.output?.type)) return result.output
  if (value === undefined || value === null || value === '') return { type: 'text', value: '工具执行成功，但没有输出' }
  if (typeof value === 'string') return { type: 'text', value }
  return { type: 'json', value }
}

/** Drain generator/async-generator returns: each chunk is streamed, all chunks become the value. */
async function collect(result) {
  if (!result || typeof result.next !== 'function' ||
      (typeof result[Symbol.asyncIterator] !== 'function' && typeof result[Symbol.iterator] !== 'function')) return result
  const chunks = []
  for await (const chunk of result) { chunks.push(chunk); report('result', chunk) }
  return chunks
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function main() {
  const request = await readStdin()

  if (request.mode === 'shutdown') return

  if (request.mode === 'describe') {
    const tools = []
    for (const url of request.urls) {
      try {
        const module = await import(url)
        for (const tool of [module.default].flat()) {
          if (!tool?.name || typeof tool.execute !== 'function') continue
          tools.push({
            url,
            name: String(tool.name),
            description: typeof tool.description === 'string' ? tool.description : '',
            inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
          })
        }
      } catch (error) {
        tools.push({ url, error: error?.message ?? String(error) })
      }
    }
    process.stdout.write(encoder.encode(JSON.stringify({ ok: true, tools }) + '\n'))
    return
  }

  if (request.mode === 'call') {
    try {
      const module = await import(request.url)
      const tool = [module.default].flat().find(one => one?.name === request.name)
      if (!tool || typeof tool.execute !== 'function') throw new Error(`tool ${request.name} not found in ${request.url}`)
      const raw = await tool.execute(request.input, { signal: undefined, toolCallId: request.toolCallId })
      const value = await collect(raw)
      const output = shape(tool.toModelOutput ? await tool.toModelOutput({ output: value, input: request.input, toolCallId: request.toolCallId }) : value)
      process.stdout.write(encoder.encode(JSON.stringify({ ok: true, output }) + '\n'))
    } catch (error) {
      process.stdout.write(encoder.encode(JSON.stringify({ ok: false, error: error?.message ?? String(error) }) + '\n'))
    }
    return
  }

  throw new Error(`unknown mode: ${request.mode}`)
}

main().catch(error => {
  process.stdout.write(encoder.encode(JSON.stringify({ ok: false, error: error?.message ?? String(error) }) + '\n'))
  process.exitCode = 1
})
