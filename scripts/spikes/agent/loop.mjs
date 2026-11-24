// The tool-calling loop for the agent spike: sends the conversation with the tool definitions
// through the Gateway (OpenAI-style "tools"; the Gateway passes them through, checked 2026-11-23 on
// all six menu models), runs each tool call through the session's handlers, and stops when the model
// calls finish, answers without a tool call, or the turn limit is reached. Counts what the scoring
// needs: calls, tokens, cost, seconds, tool calls made, malformed ones, unknown tools.

import { chat, catalogRows, withThinking } from '../gateway.mjs';

// Tool results older than this many turns are cut to a line, to keep the context from growing
// without bound; the model can read again.
const KEEP_FULL_TURNS = 6;
const MAX_RESULT_CHARS = 12000;

// `readTurns`: after this many turns the reading tools are taken away, so the model decides with
// what it has read (measured: with reading always open, DeepSeek V4.1 Flash read for every turn it
// had and decided nothing).
const READING = new Set(['read_paragraphs', 'find_text']);

export async function runAgent({ model, thinking = 'off', system, user, tools, handlers, maxTurns = 30, maxOutput = 6000, tag = 'agent', salt = '', log = () => {}, budget = Infinity, readTurns = Infinity }) {
  const rows = await catalogRows();
  const row = rows.get(model);
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const stats = { turns: 0, calls: 0, cached: 0, prompt: 0, completion: 0, cost: 0, seconds: 0, toolCalls: 0, malformed: 0, unknownTool: 0, textOnlyTurns: 0, failures: {}, byTool: {}, stopped: null };
  const toolTurn = [];
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (stats.cost >= budget) { stats.stopped = 'budget'; break; }
    stats.turns += 1;
    // Older tool results shrink to a stub.
    const trimmed = messages.map((message, at) => (message.role === 'tool' && toolTurn[at] !== undefined && turn - toolTurn[at] > KEEP_FULL_TURNS && message.content.length > 200 ? { ...message, content: `${message.content.slice(0, 160)}… (older result cut; read again if needed)` } : message));
    const reading = turn < readTurns;
    const offered = reading ? tools : tools.filter(tool => !READING.has(tool.function.name));
    const payload = withThinking({ model, temperature: 0, messages: trimmed, tools: offered, tool_choice: 'auto' }, row, thinking, maxOutput, 16000);
    let answer;
    try {
      answer = await chat(payload, { thinking, tag, salt: `${salt}#${turn}` });
    } catch (error) {
      stats.failures[error.code ?? 'error'] = (stats.failures[error.code ?? 'error'] ?? 0) + 1;
      if (error.code === 'spend_cap') { stats.stopped = 'spend_cap'; break; }
      if ((stats.failures[error.code] ?? 0) >= 3) { stats.stopped = `failed: ${error.code}`; break; }
      turn -= 1; stats.turns -= 1;
      continue;
    }
    stats.calls += 1; stats.cached += answer.cached ? 1 : 0; stats.prompt += answer.usage.prompt; stats.completion += answer.usage.completion; stats.cost += answer.cost; stats.seconds += answer.seconds;
    const message = answer.message ?? {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    messages.push({ role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) });
    if (!calls.length) {
      stats.textOnlyTurns += 1;
      log(`turn ${turn}: no tool call (${answer.finish})`);
      if (stats.textOnlyTurns >= 2) { stats.stopped = 'no_tool_call'; break; }
      messages.push({ role: 'user', content: 'Use the tools: carry on with the work, or call finish when it is done.' });
      continue;
    }
    let finished = false;
    for (const call of calls) {
      stats.toolCalls += 1;
      const name = call?.function?.name;
      let args = null;
      try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = null; }
      let result;
      if (!handlers[name]) { stats.unknownTool += 1; result = `ERROR: no tool named ${name}`; }
      else if (!reading && READING.has(name)) { stats.readRefused = (stats.readRefused ?? 0) + 1; result = 'REFUSED: reading is closed for this part; decide every item now with what you have, then call finish.'; }
      else if (!args || typeof args !== 'object') { stats.malformed += 1; result = 'ERROR: the arguments are not a JSON object'; }
      else {
        stats.byTool[name] = (stats.byTool[name] ?? 0) + 1;
        try { result = String(handlers[name](args)); } catch (error) { stats.malformed += 1; result = `ERROR: ${error.message}`; }
        if (name === 'finish') finished = true;
      }
      toolTurn[messages.length] = turn;
      messages.push({ role: 'tool', tool_call_id: call.id, content: result.slice(0, MAX_RESULT_CHARS) });
    }
    log(`turn ${turn}: ${calls.map(call => call?.function?.name).join(', ')} (${stats.cost.toFixed(3)} $)`);
    if (turn + 1 === readTurns && !finished) messages.push({ role: 'user', content: 'Reading is now closed for this part. Decide every item listed (resolve_findings, triage_rules, set_setting, replace_text, delete_paragraphs, insert_contents, set_roles, ask_author as needed), then call finish.' });
    if (finished) { stats.stopped = 'finish'; break; }
  }
  stats.stopped ??= 'turn_limit';
  return { stats, messages };
}
