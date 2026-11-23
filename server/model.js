// Output budget and reasoning controls for one model call, from the model's catalog row (undefined
// when the model is unlisted or the catalog is unreadable).

// Workers AI Chat defaults max_tokens to 256 when the caller omits it (Gateway adds a default only
// for GPT-OSS), which truncates any JSON reply. Non-reasoning Workers AI and unlisted models ask
// for this much room, capped at half the model's context window so the input still fits.
const MAX_OUTPUT_TOKENS = 16000;
// Reasoning models bill thinking as output. LanGames measured (2026-09-20) that 4,000 tokens of
// headroom let every recommended reasoning model answer, while a larger budget let one reason past a
// two-minute timeout. So reasoning models get the catalog-gated reasoning_effort "low" (and, on Workers
// AI, enable_thinking: false), 4,000 tokens of headroom plus room for the expected output, and a hard
// cap that a model can emit well inside the 180 s deadline.
const REASONING_HEADROOM_TOKENS = 4000;
const REASONING_MAX_TOKENS = 10000;

// With { thinking: true } a reasoning model keeps its thinking on (low effort) and gets the whole
// hard cap: a call that must weigh many small judgments together, such as the roles of a passage's
// paragraphs, is worth the extra output. `maxTokens` sets another hard cap for such a call (the
// reading check, whose thinking can outrun the usual one), still held under half the context
// window and under the catalog's own output limit when the row gives one.
export function modelControls(row, expectedOutputTokens, { thinking = false, maxTokens = REASONING_MAX_TOKENS } = {}) {
  const contextCap = Number.isInteger(row?.context_length) && row.context_length > 0 ? Math.floor(row.context_length / 2) : Infinity;
  const outputCap = Number.isInteger(row?.max_output_tokens) && row.max_output_tokens > 0 ? row.max_output_tokens : Infinity;
  if (row?.capabilities.includes('reasoning') && thinking) {
    return { max_tokens: Math.min(maxTokens, contextCap, outputCap), reasoning_effort: 'low', ...(row.provider === 'workers-ai' ? { chat_template_kwargs: { enable_thinking: true } } : {}) };
  }
  if (row?.capabilities.includes('reasoning')) {
    // The Gateway rejects reasoning_effort for a model without the reasoning capability, so it is
    // sent only on the catalog's say-so; enable_thinking is a Workers AI chat-template switch.
    return { max_tokens: Math.min(REASONING_HEADROOM_TOKENS + expectedOutputTokens, REASONING_MAX_TOKENS, contextCap), reasoning_effort: 'low', ...(row.provider === 'workers-ai' ? { chat_template_kwargs: { enable_thinking: false } } : {}) };
  }
  // Other non-reasoning routes keep their provider default, which is not known to be small.
  if (row && row.provider !== 'workers-ai') return {};
  return { max_tokens: Math.min(MAX_OUTPUT_TOKENS, contextCap) };
}
