import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { Llm, LlmTurn, Message, ToolSpec } from './agent.js';

/** OpenAI function-calling adapter (the project's single LLM provider, PRD Open Question #1). */
export function createOpenAiLlm(apiKey: string, model: string): Llm {
  // One retry on transient failure (TRD §12); the gateway path itself never retries.
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 60_000 });
  return {
    async complete(messages: Message[], tools: ToolSpec[]): Promise<LlmTurn> {
      const res = await client.chat.completions.create({
        model,
        messages: messages.map(toOpenAi),
        tools: tools.map((t) => ({ type: 'function' as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
      });
      const msg = res.choices[0]?.message;
      const toolCalls = (msg?.tool_calls ?? []).flatMap((c) => {
        if (c.type !== 'function') return [];
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = { _unparseable_arguments: c.function.arguments };
        }
        return [{ id: c.id, name: c.function.name, arguments: args }];
      });
      return { content: msg?.content ?? null, toolCalls };
    },
  };
}

function toOpenAi(m: Message): ChatCompletionMessageParam {
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      ...(m.tool_calls
        ? { tool_calls: m.tool_calls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) }
        : {}),
    };
  }
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
  return { role: m.role, content: m.content };
}
