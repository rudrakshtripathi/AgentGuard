# AgentGuard TypeScript SDK

Install the workspace package from this repository and create an `AgentGuardClient` with the API URL and the agent API key. The package has no runtime dependencies; it uses Node's built-in `fetch`.

```ts
import { createAgentGuardClient } from "@agentguard/sdk";

const client = createAgentGuardClient({
  baseUrl: process.env.AGENTGUARD_URL!,
  apiKey: process.env.AGENTGUARD_API_KEY!,
  timeoutMs: 15_000,
});

// The callable implementation belongs behind the gateway. This placeholder supplies a name;
// the SDK intentionally never invokes the local callback.
async function send_email(_params: {
  to: string;
  subject: string;
  body: string;
}) {
  throw new Error("Do not expose a direct agent-side implementation.");
}

const sendEmail = client.guard(send_email, { toolName: "send_email" });
const gatewayExecution = await sendEmail({
  to: "demo@acme.example",
  subject: "Status",
  body: "Routine update.",
});
```

## Security boundary

The agent must receive only guarded handles and function schemas. Never give the agent a direct reference, credential, import, or alternate route to the original tool implementation. A direct local function call bypasses AgentGuard. In a real deployment, put the implementation and its credentials behind the gateway; this repository currently executes sandboxed mock tools only. The `toolFn` argument passed to `guard` supplies a default name only and is never called by the SDK.

The SDK sends `{tool_name, params}` to `/api/tool-call` using the agent key. On `allow`, it returns the gateway's execution object. On `block`, it throws `AgentGuardBlockedError` with policy reasons. A pending call throws `PendingApprovalError` by default; pass `waitForApproval: true` to hold the HTTP request for a decision. Timeouts, network errors, malformed responses, and an allow response without a valid execution result throw typed errors and never invoke the local callback.

```ts
const result = await client.guard(process_payment, {
  toolName: "process_payment",
  waitForApproval: true,
})({
  recipient: "Demo Vendor",
  amount: 42,
});
```

Examples using framework-agnostic handles and OpenAI function calling live in [`packages/agentguard-sdk/examples`](../packages/agentguard-sdk/examples). They use mock AgentGuard tools and environment variables; do not put credentials in source files.
