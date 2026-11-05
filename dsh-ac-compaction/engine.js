/**
 * dsh-ac-compaction — engine half.
 *
 * A BasicCompactionEngine subclass whose ONLY change is the summarization
 * instruction. Pressure thresholds, retention, the bracket transaction, tool
 * pairing, overflow recovery, and shrink validation are all inherited
 * untouched from @deepseek-ai/dsh-compaction-basic.
 *
 * Instruction deltas vs the stock COMPACTION_INSTRUCTION:
 * - the user's original goal is demanded verbatim as the first section, and
 *   must survive even when other sections shrink;
 * - an explicit drop-list (greetings, repeated tool transcripts, superseded
 *   output) so the summary shrinks instead of accreting across compactions;
 * - the prior-checkpoint rule is kept and sharpened: still-true facts must be
 *   carried into the new summary, never silently dropped.
 *
 * The call shape is byte-for-byte the stock one: replayed prefix + tools +
 * trailing instruction user message, purpose "compaction", abort forwarded —
 * so the provider's warm prefix cache keeps working and every downstream
 * accounting (usage, rawOutput, llmStreamCall) stays identical.
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, LlmError, contentHasImage, deepFreeze } from '@deepseek-ai/dsh-llm'

const SUMMARY_OPEN_TAG = '<compacted-summary>'

/** The enhanced instruction; delivered as the final user message after the replayed conversation. */
const AC_COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  '- [the user\'s ORIGINAL goal verbatim (quote the first request), plus how it evolved; this section must ALWAYS be filled even when every other section shrinks]',
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- DROP without mercy: greetings, social filler, duplicated tool transcripts, superseded intermediate output, and anything already captured in a later section.',
  '- The summary must be SMALLER than what it replaces: condensing is the point. When in doubt between two details, keep the one a resuming model cannot re-derive.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n')

/** Reject visual output and keep only text. */
function summaryText(blocks) {
  if (contentHasImage(blocks)) throw new LlmError('compaction summary cannot contain image output', 'UNSUPPORTED_CONTENT')
  return blocks.filter(block => block.type === 'text')
}

/** Resolve the summarization target exactly like the stock engine. */
function conversationTarget(agent) {
  const header = agent.session.requestHeader()?.config
  if (header?.provider?.length > 0 && header?.model?.length > 0) return { provider: header.provider, model: header.model }
  if (agent.options.provider?.length > 0 && agent.options.model?.length > 0) return { provider: agent.options.provider, model: agent.options.model }
  return undefined
}

export class AcCompactionEngine extends BasicCompactionEngine {
  /**
   * Same call envelope as the stock summarize(), one delta: the instruction.
   * Kept local instead of calling super() with patched input because the stock
   * path reads its instruction from a module constant; replaying the envelope
   * here keeps warm-prefix reuse and all downstream accounting identical.
   */
  async summarize(input, agent, signal) {
    const config = this.config
    const configured = config.summarizationProvider.length === 0 ? undefined : { provider: config.summarizationProvider, model: config.summarizationModel }
    // fixes #3: reuse the shared resolver instead of duplicating its precedence.
    const target = configured ?? conversationTarget(agent)
    if (target === undefined) throw new Error('no provider/model available for summarization: set both summarization fields, route one request, or set both AgentOptions fields')

    const assembler = new BlockAssembler()
    const messages = [...input.messages, deepFreeze({
      role: 'user',
      content: [{ type: 'text', text: AC_COMPACTION_INSTRUCTION }],
    })]
    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    }
    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)

    if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') {
      const failure = assembler.finish.failure
      throw new LlmError(failure.message, failure.code, failure)
    }
    if (assembler.finish.kind === 'max-tokens') {
      const error = new Error('summarization truncated at the token cap (incomplete checkpoint)')
      error.code = 'MAX_TOKENS'
      throw error
    }

    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some(block => block.text.trim().length > 0)) throw new Error('summarization produced no text summary content')
    return {
      summary,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: config.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
}

export default AcCompactionEngine
