// Live, unscripted demo run:  npm run agent -- "Email the weekly report to maria@acme.example"
// Requires OPENAI_API_KEY, DEMO_AGENT_API_KEY and a running AgentGuard API.
import { AgentGuardClient, runAgent } from './agent.js';
import { createOpenAiLlm } from './openaiLlm.js';

const task = process.argv.slice(2).join(' ').trim();
const { OPENAI_API_KEY, OPENAI_MODEL, DEMO_AGENT_API_KEY, AGENTGUARD_URL } = process.env;
if (!task) {
  console.error('usage: npm run agent -- "<task for the agent>"');
  process.exit(1);
}
if (!OPENAI_API_KEY || !DEMO_AGENT_API_KEY) {
  console.error('OPENAI_API_KEY and DEMO_AGENT_API_KEY must be set in .env. (Canned scenarios on /demo need no LLM key.)');
  process.exit(1);
}

const guard = new AgentGuardClient(AGENTGUARD_URL ?? 'http://127.0.0.1:4000', DEMO_AGENT_API_KEY);
const llm = createOpenAiLlm(OPENAI_API_KEY, OPENAI_MODEL || 'gpt-4o-mini');
console.log(`task: ${task}\n(approval-gated calls wait here until a reviewer acts on /approvals)\n`);
try {
  const { answer } = await runAgent(task, llm, guard, {
    onStep: (s) => {
      if (s.error) console.log(`→ ${s.tool}: ERROR ${s.error}`);
      else console.log(`→ ${s.tool} ${JSON.stringify(s.arguments)}\n  AgentGuard: ${s.outcome!.decision.toUpperCase()} — ${s.outcome!.reason}\n  executed: ${s.outcome!.execution?.executed ?? false}`);
    },
  });
  console.log(`\nagent: ${answer}`);
} catch (err) {
  console.error(`demo agent failed: ${(err as Error).message}`);
  process.exit(1);
}
