/**
 * dsh-ac-compaction — no-tool nudge row (agent-core's noToolPrompt, DSH edition).
 *
 * When the model produces steps without any tool call while tools exist, it is
 * often "politeness-stopping" before the task is actually done (agent-core's
 * measured rationale). This row watches consecutive tool-less assistant steps
 * on each session and, at the threshold, appends a one-shot reminder to the
 * messages entering the next model step.
 *
 * Discipline (mirrors agent-core):
 * - the reminder rides the pre-step waterfall: it enters the model request but
 *   is never written to the session log — it is something said TO the model,
 *   not something that HAPPENED in the conversation;
 * - never rejects: every path calls next() — denial stays the host's business;
 * - after maxNudges consecutive reminders it goes quiet (no infinite nagging,
 *   no unbounded spend);
 * - any step WITH tool calls resets the counter;
 * - sessions with no visible tools (or a user just spoke) are not nudged;
 * - per-session counter lives in a WeakMap, so disposal is automatic.
 */

export const inject = []

const NUDGE_TEXT = '[系统提醒] 你刚才的回复中没有使用任何工具！如果任务尚未完成，请继续使用工具推进（这是一条系统提醒消息，请勿以对话形式回复）。如果任务确实已经全部完成，请明确说明完成状态与结果。'

export function apply(ctx, config = {}) {
  const afterSteps = Number.isFinite(config.afterSteps) && config.afterSteps >= 1 ? Math.floor(config.afterSteps) : 1
  const maxNudges = Number.isFinite(config.maxNudges) && config.maxNudges >= 0 ? Math.floor(config.maxNudges) : 2

  const state = new WeakMap() // Session -> { toolless: number, nudged: number }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    try {
      const session = agent.session
      const surface = session.surface?.nodes ?? []
      if (surface.length === 0) return next()

      // The last surface event decides whether a nudge is even relevant:
      // only when the model just spoke (assistant/message) can it be "politeness-stopping".
      const lastSeq = surface[surface.length - 1]
      const lastEvent = session.eventAt(lastSeq)
      if (lastEvent?.type !== 'assistant/message') return next()

      // No visible tools? Then a tool-less reply IS the correct final answer.
      const tools = agent.session.requestHeader()?.tools
      if (!Array.isArray(tools) || tools.length === 0) return next()

      // Count consecutive assistant steps without tool calls, walking backwards
      // over the current surface until a tool call, a user message, or the head.
      let toolless = 0
      for (let i = surface.length - 1; i >= 0; i -= 1) {
        const event = session.eventAt(surface[i])
        if (event === undefined || event.seq !== surface[i]) break
        if (event.type === 'assistant/message') {
          const hasCall = Array.isArray(event.data?.message?.content) &&
            event.data.message.content.some(block => block?.type === 'tool-call')
          if (hasCall) break
          toolless += 1
          continue
        }
        if (event.type === 'user/message' || event.type === 'tool/result') break
      }
      if (toolless === 0) return next()

      const s = state.get(session) ?? { toolless: 0, nudged: 0 }
      // Reset when the toolless streak shrank (model went back to work).
      if (toolless < s.toolless) { s.toolless = toolless; s.nudged = 0; state.set(session, s); return next() }
      s.toolless = toolless

      // Nudge exactly when the streak reaches the threshold, then go quiet.
      if (toolless !== afterSteps || s.nudged >= maxNudges) { state.set(session, s); return next() }
      s.nudged += 1
      state.set(session, s)

      // One-shot: replace the entering messages with the reminder appended.
      // Pre-step replace does not persist to the log — exactly agent-core's
      // "temporary prompt, not history" discipline.
      const patched = [...messages, {
        role: 'user',
        content: [{ type: 'text', text: NUDGE_TEXT }],
      }]
      return next({ messages: patched })
    } catch {
      // Any surprise: never break the host loop, just don't nudge.
      return next()
    }
  })
}
