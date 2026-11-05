/**
 * dsh-ac-compaction — system half.
 *
 * Promotes the latest compaction summary into the system prompt.
 *
 * Why: a summary that only exists as a user-role checkpoint message competes
 * with every other message for the model's attention and can be shadowed by a
 * later compaction. agent-core's measured finding is that folding the summary
 * into the system prompt (with a "this is your own completed work, continue"
 * framing) took correct-resume behavior from 1/6 to 6/6 on a real endpoint.
 *
 * Mechanism (zero engine changes, fully reversible):
 * - on every `agent/created`, register in that agent's own scope a
 *   `systemPrompt.section` whose text is computed at assembly time from the
 *   session log (no stored state — replay-safe, multi-session safe);
 * - track the newest summary per session from `session/event` compaction/summary
 *   records, falling back to a bounded log scan when this plugin missed the event
 *   (e.g. the summary predates plugin activation);
 * - when no summary exists the section returns '' and renders nothing.
 *
 * The section is additive: DSH still writes its own checkpoint user message, so
 * if this section ever fails to render, compaction degrades to stock behavior.
 */

export const inject = []

const SECTION_NAME = 'dsh-ac-compaction-system-summary'
const SECTION_ORDER = 10050 // after harness runtime guidance, before persona suffix (10200)

/** Extract the joined text of a compaction/summary event's summary blocks. */
function summaryText(summary) {
  if (!Array.isArray(summary)) return ''
  return summary.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
}

/**
 * Find the newest compaction/summary record in one session's log.
 * Bounded backward scan; returns '' when none exists.
 */
function latestSummaryFromLog(session, maxScan = 4000) {
  const floor = Math.max(0, session.seq - maxScan)
  for (let seq = session.seq - 1; seq >= floor; seq -= 1) {
    const event = session.eventAt(seq)
    if (event === undefined || event.seq !== seq) return ''
    if (event.type === 'compaction/summary') return summaryText(event.data?.summary)
  }
  return ''
}

export function apply(ctx) {
  const summaries = new WeakMap() // Session -> latest summary text

  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'compaction/summary') return
    const text = summaryText(event.data?.summary)
    if (text) summaries.set(session, text)
  })

  ctx.on('agent/created', ({ agent }) => {
    const session = agent.session
    const scoped = agent.ctx

    // Latest known summary at registration time; refreshed live at assembly.
    // New agents start with an empty log cache; the provider falls back to a
    // bounded log scan so a summary written before plugin activation still shows.
    let cached = summaries.get(session) ?? ''

    const stopTracking = session.ctx?.on?.('session/event', (_session, event) => {
      if (event?.type !== 'compaction/summary') return
      const text = summaryText(event.data?.summary)
      if (text) { summaries.set(session, text); cached = text }
    })

    scoped.systemPrompt.section({
      name: SECTION_NAME,
      order: SECTION_ORDER,
      interpolate: false,
      text: () => {
        const current = summaries.get(session) ?? cached
        const text = current || latestSummaryFromLog(session)
        if (!text) return ''
        return [
          '【你此前工作的压缩记录】',
          '下面是之前压缩生成的、关于你自己已完成工作的摘要，用来帮你衔接上下文。',
          '其中可能夹带当时的待办、推测或已经过时的说法，并不等同于已确认的事实；需要时请自行核对。',
          '',
          text,
        ].join('\n')
      },
    })

    return async () => {
      summaries.delete(session)
      if (stopTracking) await Promise.resolve(stopTracking()).catch(() => {})
    }
  })
}
