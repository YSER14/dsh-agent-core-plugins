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
function buildDefinitions(ctx, config, metas, log) {
  const prefix = `${config.namespace}_`
  const definitions = []
  const rejected = []
  const claimed = new Set() // names taken in THIS batch (fixes #5: get() only sees committed tools)

  for (const meta of metas) {
    if (meta.error) { rejected.push({ source: meta.url, reason: `load failed: ${meta.error}` }); continue }
    if (typeof meta.name !== 'string' || meta.name.trim().length === 0) {
      rejected.push({ source: meta.url, reason: `invalid tool name ${JSON.stringify(meta.name)}` })
      continue
    }
    const toolName = `${prefix}${meta.name}`
    if (claimed.has(toolName)) {
      rejected.push({ source: meta.url, reason: `duplicate name in this batch: ${toolName}` })
      continue
    }
    if (ctx.tools.get(toolName) !== undefined) {
      // Collision policy: refuse loudly, never override an existing tool.
      rejected.push({ source: meta.url, reason: `name collision: ${toolName} is already registered` })
      continue
    }
    claimed.add(toolName)
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
          const request = { mode: 'call', url: meta.url, name: meta.name, input: args ?? {}, toolCallId: exec?.toolCallId }
          // fixes #2: AbortSignal.signal() does not exist — compose what exists.
          const timeout = AbortSignal.timeout(config.timeoutMs)
          const signal = exec?.signal ? AbortSignal.any([exec.signal, timeout]) : timeout
          const result = await subprocessCall(ctx, config, request, signal, log)
          return renderOutput(truncateOutput(config, result.output))
        },
      },
    })
  }
  return { definitions, rejected }
}

/** One execute() call; split from buildDefinitions so the abort signal can be threaded cleanly. */
function subprocessCall(ctx, config, request, signal, log) {
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
    // fixes #3: the child's '#' progress lines were silently dropped — relay them to the log.
    for (const line of lines) {
      if (!line.startsWith('#')) continue
      try {
        const progress = JSON.parse(line.slice(1))
        log?.info?.(`[${request.name}] ${progress.stream}: ${progress.data}`)
      } catch { /* malformed progress line: ignore */ }
    }
    const finalLine = [...lines].reverse().find(line => !line.startsWith('#'))
    if (!finalLine) throw new Error(`工具没有返回结果；stderr: ${stderrText.slice(0, 400)}`)
    let parsed
    try { parsed = JSON.parse(finalLine) } catch { throw new Error(`工具返回值不是合法 JSON：${finalLine.slice(0, 200)}`) }
    if (!parsed.ok) throw new Error(parsed.error ?? '工具执行失败')
    // fixes #10: an error-text block is a failure, not a successful string result.
    if (parsed.output?.type === 'error-text') throw new Error(String(parsed.output.value ?? '工具返回错误'))
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
function renderOutput(output) {
  return output?.type === 'text' ? output.value : JSON.stringify(output?.value)
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
  const unwatchers = []
  let disposed = false
  let syncing = false
  let pending = false

  /** Unregister everything this plugin added. Idempotent. */
  const unregisterAll = async () => {
    const queued = disposers.splice(0)
    for (const dispose of queued) await Promise.resolve(dispose()).catch(() => {})
    return queued.length
  }

  /** Full scan + register cycle; returns how many tools this pass produced. */
  const syncOnce = async () => {
    await unregisterAll() // a reload always starts from zero so removed files lose their tools too
    if (disposed) return 0 // fixes #6: never register after the plugin was disposed
    const files = await collectToolFiles(fs, resolved.dirs, log)
    if (disposed) return 0
    const urls = files.map(file => pathToFileURL(file).href)
    if (!urls.length) {
      log.info('no tool files found in', resolved.dirs)
      return 0
    }
    const described = await runRunner(subprocess, { mode: 'describe', urls }, resolved)
    if (disposed) return 0
    if (!described.ok) fail(`describe failed: ${described.error}`)
    const { definitions, rejected } = buildDefinitions(ctx, resolved, described.tools, log)
    for (const { source, reason } of rejected) log.warn(`skipped ${source}: ${reason}`)
    if (disposed) return 0
    // fixes #5: register as a transaction — a failure mid-pass must not leave a half set.
    const added = []
    try {
      for (const { definition } of definitions) added.push(ctx.tools.register(definition))
    } catch (error) {
      for (const dispose of added) await Promise.resolve(dispose()).catch(() => {})
      throw error
    }
    disposers.push(...added)
    log.info(`registered ${definitions.length} tool(s) from ${resolved.dirs.length} dir(s)`)
    return definitions.length
  }

  /**
   * Single-flight sync (fixes #2): concurrent directory events share one pass and
   * a change that arrives mid-pass queues exactly one re-run, so the last save is
   * never dropped and two passes never unregister each other's tools.
   */
  const requestSync = async () => {
    if (disposed) return 0
    if (syncing) { pending = true; return 0 }
    syncing = true
    try {
      let count = 0
      do {
        pending = false
        count = await syncOnce()
      } while (pending && !disposed)
      return count
    } finally {
      syncing = false
    }
  }

  // Initial scan runs async (it spawns the runner); failures are visible in logs
  // but never abort plugin activation with a half-registered tool set.
  void requestSync().catch(error => log.error('initial scan failed:', error?.message ?? error))

  // Hot reload: watch each configured directory; on change, re-scan.
  if (resolved.watch) {
    void (async () => {
      for (const dir of resolved.dirs) {
        if (disposed) return
        try {
          const target = await fs.resolve(dir)
          if (disposed) return
          const stop = await fs.watch(target, () => {
            void requestSync().catch(error => log.error('hot reload failed:', error?.message ?? error))
          }, ctx.signal ?? undefined)
          // fixes #2: keep the stop function so disposal actually stops the watcher.
          unwatchers.push(stop)
        } catch (error) {
          log.warn(`watch unavailable for ${dir}: ${error?.message ?? error}`)
        }
      }
    })().catch(error => log.error('watch setup failed:', error?.message ?? error))
  }

  // Cleanup path: mark disposed first, then stop watchers and unregister every tool.
  ctx.effect(() => async () => {
    disposed = true
    for (const stop of unwatchers.splice(0)) await Promise.resolve(stop()).catch(() => {})
    await unregisterAll()
  })
}
