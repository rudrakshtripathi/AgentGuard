import { createAgentGuardClient } from '@agentguard/sdk';
import process from 'node:process';
import { log } from 'node:console';

const client = createAgentGuardClient({
  baseUrl: process.env.AGENTGUARD_URL,
  apiKey: process.env.AGENTGUARD_API_KEY,
});

// The implementation remains on the gateway. This placeholder only supplies a stable name;
// the SDK never invokes it in the agent process.
async function send_email(_params) {
  throw new Error('The agent must use the guarded handle, never a local tool implementation.');
}

const agentTools = {
  send_email: client.guard(send_email, { toolName: 'send_email' }),
};

const result = await agentTools.send_email({ to: 'demo@acme.example', subject: 'Status', body: 'Routine update.' });
log(result);
