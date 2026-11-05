/**
 * dsh-ac-compaction — no-tool nudge row (agent-core's noToolPrompt, DSH edition).
 *
 * When the model produces steps without any tool call while tools exist, it is
 * often "politeness-stopping" before the task is actually done. This row watches
 * consecutive tool-less assistant steps **inside the current user turn** and, at
 * the threshold, appends a one-shot reminder to the messages entering the next
 * model step.
 *
 * Discipline (mirrors agent-core):
 * - the reminder rides the pre-step waterfall: it enters the model request but
 *   is never written to the session log — it is something said TO the model,
 *   not something that HAPPENED in the conversation;
 * - never rejects: every path calls next() — denial stays the host's business;
 * - at most `maxNudges` reminders per user turn (see fixes #1, #7: the counter is
 *   reset by the turn anchor — the seq of the newest user message — not by a
 *   shrinking streak, so a fresh request never inherits spent budget);
 * - any step WITH tool calls breaks the streak and stops further reminders;
 * - sessions with no visible tools are not nudged;
 * - per-session state lives in a WeakMap, so disposal is automatic.
 */

export const inject = []

const NUDGE_TEXT = '[系统提醒] 你刚才的回复中没有使用任何工具！如果任务尚未完成，请继续使用工具推进（这是一条系统提醒消息，请勿以对话形式回复）。如果任务确实已经全部完成，请明确说明完成状态与结果。'

export function apply(ctx, config = {}) {
  const afterSteps = Number.isFinite(config.afterSteps) && config.afterSteps >= 1 ? Math.floor(config.afterSteps) : 1
  const maxNudges = Number.isFinite(config.maxNudges) && config.maxNudges >= 0 ? Math.floor(config.maxNudges) : 2

  const state = new WeakMap() // Session -> { anchor: number | null, nudged: number }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    try {
      const session = agent.session
      const surface = session.surface?.nodes ?? []
      if (surface.length === 0) return next()

      // Only when the model just spoke can it be "politeness-stopping".
      const lastEvent = session.eventAt(surface[surface.length - 1])
      if (lastEvent?.type !== 'assistant/message') return next()

      // No visible tools? Then a tool-less reply IS the correct final answer.
      const tools = agent.session.requestHeader()?.tools
      if (!Array.isArray(tools) || tools.length === 0) return next()

      // Walk the current turn backwards. The turn anchor is the newest user
      // message; it both bounds the streak and identifies the turn (fixes #7).
      let anchor = null
      let toolless = 0
      for (let i = surface.length - 1; i >= 0; i -= 1) {
        const event = session.eventAt(surface[i])
        if (event === undefined || event.seq !== surface[i]) break
        if (event.type === 'user/message') { anchor = surface[i]; break }
        if (event.type === 'assistant/message') {
          const hasCall = Array.isArray(event.data?.message?.content) &&
            event.data.message.content.some(block => block?.type === 'tool-call')
          if (hasCall) break // the model already used a tool in this turn
          toolless += 1
          continue
        }
        if (event.type === 'tool/result') break
      }

      const previous = state.get(session)
      // A new user turn resets the budget, regardless of how long the streak is.
      const counters = previous && previous.anchor === anchor ? previous : { anchor, nudged: 0 }

      if (toolless < afterSteps || counters.nudged >= maxNudges) {
        state.set(session, counters)
        return next()
      }

      counters.nudged += 1
      state.set(session, counters)

      // One-shot: replace the entering messages with the reminder appended.
      // Pre-step replacement does not persist — agent-core's "temporary prompt,
      // not history" discipline.
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
