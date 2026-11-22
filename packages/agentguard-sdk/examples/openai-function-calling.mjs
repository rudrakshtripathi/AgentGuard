import OpenAI from 'openai';
import { createAgentGuardClient } from '@agentguard/sdk';
import process from 'node:process';
import { log } from 'node:console';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const gateway = createAgentGuardClient({ baseUrl: process.env.AGENTGUARD_URL, apiKey: process.env.AGENTGUARD_API_KEY });

// This is a descriptor placeholder, not an executable agent-side tool implementation.
async function send_email(_params) {
  throw new Error('The agent must call AgentGuard; the implementation belongs behind the gateway.');
}
const guarded = gateway.guard(send_email, { toolName: 'send_email' });

const response = await openai.chat.completions.create({
  model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'Send a routine status note to demo@acme.example.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send an email through AgentGuard.',
      parameters: {
        type: 'object', additionalProperties: false, required: ['to', 'subject', 'body'],
        properties: { to: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' } },
      },
    },
  }],
  tool_choice: 'auto',
});

for (const call of response.choices[0]?.message.tool_calls ?? []) {
  if (call.type !== 'function' || call.function.name !== 'send_email') continue;
  const params = JSON.parse(call.function.arguments);
  const result = await guarded(params);
  log(result);
}
