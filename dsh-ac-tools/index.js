/**
 * dsh-ac-tools: agent-core-style directory tools for the DeepSeek Harness.
 *
 * Drop a .mjs file into a configured tools directory:
 *
 *     export default {
 *       name: 'now',
 *       description: 'Return the current time.',
 *       inputSchema: { type: 'object', properties: {} },
 *       async execute(input) { return new Date().toISOString() },
 *     }
 *
 * The plugin scans the directories through a child runner (tool code never
 * loads into the harness process), registers each entry as
 * `${namespace}_${name}` via ctx.tools.register, and executes calls in a
 * fresh subprocess with a hard timeout.
 *
 * Conflict discipline:
 * - every tool name is prefixed (default `ac_`);
 * - a name that already exists in ctx.tools is refused with a thrown error,
 *   never silently overridden;
 * - registration goes through ctx.effect, so disabling the plugin unregisters
 *   every tool it added and nothing else;
 * - the plugin reads only its own config and writes only its own logs.
 */

import { join, isAbsolute } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const CONFIG_SCHEMA = {
  dirs: Array.isArray,
  namespace: 'ac',
  timeoutMs: 60000,
  maxOutputChars: 20000,
  maxLogChars: 8000,
  watch: true,
}

/** Node executable that runs the runner; resolved from the current process. */
const nodeExecutable = process.execPath

/** Native path of runner.mjs (via fileURLToPath — a URL string is not a usable Windows path). */
const RUNNER_PATH = fileURLToPath(new URL('./runner.mjs', import.meta.url))

/** Package directory: relative config.dirs entries resolve here, not against the harness cwd. */
const PACKAGE_DIR = fileURLToPath(new URL('.', import.meta.url))

function fail(message) { throw new Error(`[dsh-ac-tools] ${message}`) }

function normalizeConfig(config) {
  const resolved = { ...CONFIG_SCHEMA, ...(config ?? {}) }
  if (!Array.isArray(resolved.dirs)) fail('config.dirs must be an array of directory paths')
  if (typeof resolved.namespace !== 'string' || !/^[a-z][a-z0-9_]*$/i.test(resolved.namespace)) fail(`config.namespace must be a simple identifier, got ${JSON.stringify(resolved.namespace)}`)
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs < 1000) fail('config.timeoutMs must be a number >= 1000')
  if (!Number.isFinite(resolved.maxOutputChars) || resolved.maxOutputChars < 200) fail('config.maxOutputChars must be a number >= 200')
  for (const dir of resolved.dirs) {
    if (typeof dir !== 'string' || dir.length === 0) fail(`config.dirs entries must be non-empty strings, got ${JSON.stringify(dir)}`)
  }
  // Absolute entries are used verbatim; relative ones (e.g. "./demo-tools") resolve
  // against this package so a checkout works on any machine without editing config.
  resolved.dirs = resolved.dirs.map(dir => (isAbsolute(dir) ? dir : join(PACKAGE_DIR, dir)))
  return resolved
}

/** Collect candidate tool files (.mjs) from the configured directories. */
async function collectToolFiles(fs, dirs, log) {
  const files = []
  for (const dir of dirs) {
    let target
    try { target = await fs.resolve(dir, { cwd: process.cwd() }) } catch (error) { log?.warn?.(`dir not resolvable, skipped: ${dir} (${error?.message ?? error})`); continue }
    let entries
    try { entries = await fs.listDir(target) } catch (error) { log?.warn?.(`dir not listable, skipped: ${dir} (${error?.message ?? error})`); continue }
    for (const entry of entries) {
      if (entry.type !== 'file') continue
      if (!entry.name.toLowerCase().endsWith('.mjs')) continue
      files.push(join(fs.processPath(target), entry.name))
    }
  }
  return files.sort()
}

/** Spawn the runner for one request; returns the final JSON line (progress '#' lines are dropped). */
async function runRunner(subprocess, request, options) {
  const { timeoutMs, maxLogChars } = options
  const argv = [nodeExecutable, RUNNER_PATH]
  const handle = subprocess.spawn({
    argv,
    cwd: process.cwd(),
    graceMs: 2000,
    signal: AbortSignal.timeout(timeoutMs),
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: Math.max(maxLogChars * 4, 1 << 20) },
      stderr: { maxBytes: maxLogChars },
    },
  })

  let stdinError
  handle.stdin?.write(Buffer.from(JSON.stringify(request) + '\n', 'utf8'))
  handle.stdin?.end()
  handle.stdin?.on?.('error', error => { stdinError = error })

  let exit
  try { exit = await handle.done } catch (error) { throw new Error(`tool runner failed to start: ${error?.message ?? error}`) }
  if (stdinError) throw new Error(`tool runner stdin failed: ${stdinError.message}`)

  const stdoutText = handle.collected?.stdout?.readFrom(0)?.text ?? ''
  const stderrText = handle.collected?.stderr?.readFrom(0)?.text ?? ''

  if (exit.exitCode !== 0) {
    const detail = stderrText.trim() || `runner exited with ${exit.exitCode}`
    throw new Error(detail)
  }

  // Final line = last NDJSON line not prefixed with '#'.
  const lines = stdoutText.split('\n').filter(line => line.trim().length > 0)
  const finalLine = [...lines].reverse().find(line => !line.startsWith('#'))
  if (!finalLine) throw new Error(`tool runner produced no result; stderr: ${stderrText.slice(0, 400)}`)
  let parsed
  try { parsed = JSON.parse(finalLine) } catch { throw new Error(`tool runner result is not valid JSON: ${finalLine.slice(0, 200)}`) }
  return parsed
}

/** Map the runner's per-file metadata into registered tools, applying namespace and collision policy. */
function buildDefinitions(ctx, config, metas) {
  const prefix = `${config.namespace}_`
  const definitions = []
  const rejected = []

  for (const meta of metas) {
    if (meta.error) { rejected.push({ source: meta.url, reason: `load failed: ${meta.error}` }); continue }
    const toolName = `${prefix}${meta.name}`
    if (ctx.tools.get(toolName) !== undefined) {
      // Collision policy: refuse loudly, never override an existing tool.
      rejected.push({ source: meta.url, reason: `name collision: ${toolName} is already registered` })
      continue
    }
    definitions.push({
      url: meta.url,
      toolName,
      definition: {
        name: toolName,
        description: meta.description || `Tool ${meta.name} loaded from ${meta.url}`,
        parameters: meta.inputSchema ?? { type: 'object', properties: {} },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
        },
        async execute(args, exec) {
          const started = Date.now()
          const request = { mode: 'call', url: meta.url, name: meta.name, input: args ?? {}, toolCallId: exec?.toolCallId }
          const signal = AbortSignal.any([exec?.signal ?? AbortSignal.signal('never'), AbortSignal.timeout(config.timeoutMs)])
          const handle = subprocessCall(ctx, config, request, signal)
          const result = await handle
          const output = truncateOutput(config, result.output)
          return renderOutput(output, Date.now() - started)
        },
      },
    })
  }
  return { definitions, rejected }
}

/** One execute() call; split from buildDefinitions so the abort signal can be threaded cleanly. */
function subprocessCall(ctx, config, request, signal) {
  const argv = [nodeExecutable, RUNNER_PATH]
  const handle = ctx.subprocess.spawn({
    argv,
    cwd: process.cwd(),
    graceMs: 2000,
    signal,
    stdio: {
      stdin: 'pipe',
      stdout: { maxBytes: Math.max(config.maxLogChars * 4, 1 << 20) },
      stderr: { maxBytes: config.maxLogChars },
    },
  })
  return (async () => {
    handle.stdin?.write(Buffer.from(JSON.stringify(request) + '\n', 'utf8'))
    handle.stdin?.end()
    let exit
    try { exit = await handle.done } catch (error) {
      const message = signal.aborted ? '工具执行超时，子进程已被终止' : `工具子进程启动失败：${error?.message ?? error}`
      throw new Error(message)
    }
    const stdoutText = handle.collected?.stdout?.readFrom(0)?.text ?? ''
    const stderrText = handle.collected?.stderr?.readFrom(0)?.text ?? ''
    if (exit.exitCode !== 0) {
      if (signal.aborted) throw new Error('工具执行超时，子进程已被终止')
      throw new Error(stderrText.trim() || `工具子进程退出码 ${exit.exitCode}`)
    }
    const lines = stdoutText.split('\n').filter(line => line.trim().length > 0)
    const finalLine = [...lines].reverse().find(line => !line.startsWith('#'))
    if (!finalLine) throw new Error(`工具没有返回结果；stderr: ${stderrText.slice(0, 400)}`)
    let parsed
    try { parsed = JSON.parse(finalLine) } catch { throw new Error(`工具返回值不是合法 JSON：${finalLine.slice(0, 200)}`) }
    if (!parsed.ok) throw new Error(parsed.error ?? '工具执行失败')
    return parsed
  })()
}

/** Truncate oversized tool output in the middle, keeping head and tail (agent-core's cutText policy). */
function truncateOutput(config, output) {
  if (!output || typeof output !== 'object') return output
  if (output.type !== 'text' && output.type !== 'json') return output
  const text = output.type === 'text' ? output.value : JSON.stringify(output.value)
  if (typeof text !== 'string' || text.length <= config.maxOutputChars) return output
  const limit = config.maxOutputChars
  const tailSize = Math.floor(limit * 0.3)
  const head = text.slice(0, Math.floor(limit * 0.7))
  const tail = tailSize > 0 ? text.slice(-tailSize) : ''
  return { type: 'text', value: `${head}\n\n……[输出过长，中间省略 ${text.length - limit} 个字符]……\n\n${tail}` }
}

/** Final tool result handed to the session. */
function renderOutput(output, ms) {
  const text = output?.type === 'text' ? output.value : JSON.stringify(output?.value)
  return text
}

export const inject = ['fs', 'subprocess', 'tools']

export function apply(ctx, config) {
  const resolved = normalizeConfig(config)
  const log = {
    info: (...args) => { if (ctx.logger?.info) ctx.logger.info('[dsh-ac-tools]', ...args); else console.log('[dsh-ac-tools]', ...args) },
    warn: (...args) => { if (ctx.logger?.warn) ctx.logger.warn('[dsh-ac-tools]', ...args); else console.warn('[dsh-ac-tools]', ...args) },
    error: (...args) => { if (ctx.logger?.error) ctx.logger.error('[dsh-ac-tools]', ...args); else console.error('[dsh-ac-tools]', ...args) },
  }

  const fs = ctx.fs
  const subprocess = ctx.subprocess
  if (!fs) fail('ctx.fs is unavailable; the filesystem service must be mounted')
  if (!subprocess) fail('ctx.subprocess is unavailable; the subprocess service must be mounted')

  const disposers = []
  const registered = () => disposers.length

  /** Unregister everything this plugin added. Idempotent. */
  const unregisterAll = async () => {
    const pending = disposers.splice(0)
    for (const dispose of pending) await Promise.resolve(dispose()).catch(() => {})
    return pending.length
  }

  /** Full scan + register cycle; returns how many tools this pass produced. */
  const syncOnce = async () => {
    await unregisterAll() // a reload always starts from zero so removed files lose their tools too
    const files = await collectToolFiles(fs, resolved.dirs, log)
    const urls = files.map(file => pathToFileURL(file).href)
    if (!urls.length) {
      log.info('no tool files found in', resolved.dirs)
      return 0
    }
    const described = await runRunner(subprocess, { mode: 'describe', urls }, resolved)
    if (!described.ok) fail(`describe failed: ${described.error}`)
    const { definitions, rejected } = buildDefinitions(ctx, resolved, described.tools)
    for (const { source, reason } of rejected) log.warn(`skipped ${source}: ${reason}`)
    for (const { definition } of definitions) {
      // tools.register returns its own disposer; keep it so hot reload and
      // plugin disposal unregister exactly what we added, nothing else.
      disposers.push(ctx.tools.register(definition))
    }
    log.info(`registered ${definitions.length} tool(s) from ${resolved.dirs.length} dir(s)`)
    return definitions.length
  }

  // Initial scan runs async (it spawns the runner); failures are visible in logs
  // but never abort plugin activation with a half-registered tool set.
  void syncOnce().catch(error => log.error('initial scan failed:', error?.message ?? error))

  // Hot reload: watch each configured directory; on change, unregister ours and re-register.
  if (resolved.watch) {
    void (async () => {
      const stopFns = []
      for (const dir of resolved.dirs) {
        try {
          const target = await fs.resolve(dir)
          let reloading = false
          const stop = await fs.watch(target, async () => {
            if (reloading) return
            reloading = true
            try {
              await syncOnce()
            } catch (error) {
              log.error('hot reload failed:', error?.message ?? error)
            } finally { reloading = false }
          }, ctx.signal ?? undefined)
          stopFns.push(stop)
        } catch (error) {
          log.warn(`watch unavailable for ${dir}: ${error?.message ?? error}`)
        }
      }
      return async () => { for (const stop of stopFns) await Promise.resolve(stop()).catch(() => {}) }
    })().catch(error => log.error('watch setup failed:', error?.message ?? error))
  }

  // Cleanup path: when the plugin is disabled, its effect disposers run; ours unregisters every tool.
  ctx.effect(() => async () => { await unregisterAll() })
}
