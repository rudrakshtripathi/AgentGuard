# AgentGuard tool-call policy — the single decision authority (TRD §1, §5).
#
# Input (built by apps/api/src/policy/policyInput.ts):
#   tool.{name, category, known}            category: communication|read|destructive|financial|unknown
#   risk.{final_score, rule_score, injection_score, injection_status, factors}
#   context.{off_hours, local_hour, agent_name, recent_call_count, duplicate_pending_call_id}
#   params                                   raw tool params (available to rules; not scored here)
#
# Output: data.agentguard.policy.result = {decision, policy_name, reasons}
#   decision ∈ {"allow", "approve", "block"}
#
# Scoring math lives in the Express Risk Scoring module, never here. This policy only maps
# the final score + metadata to an outcome. Precedence: any block rule > any approve rule >
# allow. Anything not explicitly allowed is blocked (default deny, Implementation Plan §11).
package agentguard.policy

import rego.v1

# Risk-score thresholds from the Implementation Plan's sample policy (PRD Open Question #3:
# kept as specified). The dashboard RiskMeter uses the same bands.
thresholds := {"allow_below": 30, "block_at_or_above": 70}

# A classifier probability this high is treated as a prompt-injection attempt on its own.
injection_block_threshold := 80

valid_input if {
	is_number(input.risk.final_score)
	input.risk.final_score >= 0
	input.risk.final_score <= 100
	is_string(input.tool.name)
	is_string(input.tool.category)
	valid_agent_policy
}

valid_agent_policy if {
	is_array(input.context.agent_policy.allowed_tools)
	is_array(input.context.agent_policy.allowed_email_domains)
	every value in input.context.agent_policy.allowed_tools { is_string(value) }
	every domain in input.context.agent_policy.allowed_email_domains { is_string(domain) }
	optional_number(input.context.agent_policy.max_payment_amount)
	optional_number(input.context.agent_policy.max_calls_per_minute)
}

optional_number(value) if value == null
optional_number(value) if is_number(value)

allowed_tool if {
	some name in input.context.agent_policy.allowed_tools
	name == input.tool.name
}

domain_allowed(domain) if {
	some allowed in input.context.agent_policy.allowed_email_domains
	lower(allowed) == domain
}

recipient_list(value) := [value] if is_string(value)

else := [item | some item in value; is_string(item)] if is_array(value)

else := []

email_recipients := array.concat(
	array.concat(recipient_list(object.get(input.params, "to", null)), recipient_list(object.get(input.params, "cc", null))),
	recipient_list(object.get(input.params, "bcc", null)),
)

# ------------------------------------------------------------------ block rules

block contains rule if {
	valid_input
	not allowed_tool
	rule := {"name": "block_agent_tool_not_allowed", "reason": "This tool is not allowed by the agent's policy."}
}

block contains rule if {
	valid_input
	input.tool.name == "process_payment"
	is_number(input.context.agent_policy.max_payment_amount)
	is_number(input.params.amount)
	input.params.amount > input.context.agent_policy.max_payment_amount
	rule := {"name": "block_agent_payment_cap", "reason": "Payment exceeds this agent's configured limit."}
}

block contains rule if {
	valid_input
	is_number(input.context.agent_policy.max_calls_per_minute)
	input.context.recent_call_count >= input.context.agent_policy.max_calls_per_minute
	rule := {"name": "block_agent_rate_limit", "reason": "This agent has reached its configured call limit."}
}

block contains rule if {
	valid_input
	input.tool.name == "send_email"
	some recipient in email_recipients
	some address in split(replace(recipient, ";", ","), ",")
	parts := split(trim(address, " <>"), "@")
	count(parts) == 2
	domain := lower(parts[1])
	count(input.context.agent_policy.allowed_email_domains) > 0
	not domain_allowed(domain)
	rule := {"name": "block_agent_email_domain", "reason": "Email recipient domain is not allowed by this agent's policy."}
}

block contains rule if {
	not valid_input
	rule := {"name": "block_invalid_input", "reason": "Policy input is missing or malformed; denied by default."}
}

block contains rule if {
	valid_input
	input.risk.final_score >= thresholds.block_at_or_above
	rule := {
		"name": "block_high_risk_score",
		"reason": sprintf("Final risk score %v is at or above the block threshold of %v.", [input.risk.final_score, thresholds.block_at_or_above]),
	}
}

block contains rule if {
	is_number(input.risk.injection_score)
	input.risk.injection_score >= injection_block_threshold
	rule := {
		"name": "block_prompt_injection",
		"reason": sprintf("Prompt-injection classifier score %v is at or above %v.", [input.risk.injection_score, injection_block_threshold]),
	}
}

block contains rule if {
	is_string(input.context.duplicate_pending_call_id)
	rule := {
		"name": "block_duplicate_pending",
		"reason": sprintf("An identical call (%v) from this agent is already awaiting human approval.", [input.context.duplicate_pending_call_id]),
	}
}

# ------------------------------------------------------------------ approve rules

approve contains rule if {
	valid_input
	input.risk.final_score >= thresholds.allow_below
	input.risk.final_score < thresholds.block_at_or_above
	rule := {
		"name": "approve_medium_risk_score",
		"reason": sprintf("Final risk score %v is in the human-review band [%v, %v).", [input.risk.final_score, thresholds.allow_below, thresholds.block_at_or_above]),
	}
}

approve contains rule if {
	valid_input
	input.tool.category == "destructive"
	rule := {"name": "approve_destructive_action", "reason": "Destructive actions are never auto-allowed; a human must review."}
}

approve contains rule if {
	valid_input
	input.tool.category == "financial"
	input.context.off_hours == true
	rule := {"name": "approve_financial_off_hours", "reason": sprintf("Payment requested outside business hours (local hour %v).", [input.context.local_hour])}
}

approve contains rule if {
	valid_input
	input.tool.known == false
	rule := {"name": "approve_unknown_tool", "reason": sprintf("Tool %q is not in AgentGuard's catalog; a human must review.", [input.tool.name])}
}

approve contains rule if {
	valid_input
	input.risk.injection_status == "unavailable"
	rule := {"name": "approve_degraded_scoring", "reason": "The injection classifier was unavailable, so the score is incomplete."}
}

# ------------------------------------------------------------------ allow rules

allow contains rule if {
	valid_input
	input.risk.final_score < thresholds.allow_below
	rule := {"name": "allow_low_risk_score", "reason": sprintf("Final risk score %v is below the allow threshold of %v.", [input.risk.final_score, thresholds.allow_below])}
}

# ------------------------------------------------------------------ outcome

outcome(decision, rules) := {
	"decision": decision,
	"policy_name": concat(", ", names),
	"reasons": [r.reason | some n in names; some r in rules; r.name == n],
} if {
	names := sort({r.name | some r in rules})
}

default result := {
	"decision": "block",
	"policy_name": "default_deny",
	"reasons": ["No policy rule allowed this call; denied by default."],
}

result := outcome("block", block) if {
	count(block) > 0
} else := outcome("approve", approve) if {
	count(approve) > 0
} else := outcome("allow", allow) if {
	count(allow) > 0
}

decision := result.decision
