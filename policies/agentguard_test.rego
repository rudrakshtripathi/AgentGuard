# Unit tests for the AgentGuard policy. Run: npm run opa:test  (opa test policies -v)
package agentguard.policy_test

import rego.v1

import data.agentguard.policy

mk(category, final, injection, status, ctx) := {
	"tool": {"name": tool_for(category), "category": category, "known": category != "unknown"},
	"risk": {
		"final_score": final,
		"rule_score": final,
		"injection_score": injection,
		"injection_status": status,
		"factors": [],
	},
	"context": object.union(
		{"off_hours": false, "local_hour": 11, "agent_name": "test", "recent_call_count": 0, "duplicate_pending_call_id": null},
		ctx,
	),
	"params": {},
}

tool_for("communication") := "send_email"
tool_for("read") := "run_db_query"
tool_for("destructive") := "delete_file"
tool_for("financial") := "process_payment"
tool_for("unknown") := "launch_rockets"

# --- score bands (Implementation Plan §11 thresholds)

test_low_risk_allows if {
	r := policy.result with input as mk("communication", 12, 4, "scored", {})
	r.decision == "allow"
	r.policy_name == "allow_low_risk_score"
}

test_boundary_29_99_allows if {
	policy.decision == "allow" with input as mk("read", 29.99, null, "skipped", {})
}

test_boundary_30_requires_approval if {
	r := policy.result with input as mk("communication", 30, 10, "scored", {})
	r.decision == "approve"
	r.policy_name == "approve_medium_risk_score"
}

test_medium_risk_requires_approval if {
	policy.decision == "approve" with input as mk("communication", 55, 20, "scored", {})
}

test_boundary_70_blocks if {
	r := policy.result with input as mk("communication", 70, 5, "scored", {})
	r.decision == "block"
	r.policy_name == "block_high_risk_score"
}

test_high_risk_blocks if {
	policy.decision == "block" with input as mk("read", 95, null, "skipped", {})
}

# --- metadata rules

test_destructive_never_auto_allowed if {
	r := policy.result with input as mk("destructive", 10, null, "skipped", {})
	r.decision == "approve"
	r.policy_name == "approve_destructive_action"
}

test_bulk_delete_routes_to_approval if {
	r := policy.result with input as mk("destructive", 60, 2, "scored", {})
	r.decision == "approve"
	r.policy_name == "approve_destructive_action, approve_medium_risk_score"
	count(r.reasons) == 2
}

test_financial_business_hours_low_risk_allowed if {
	policy.decision == "allow" with input as mk("financial", 20, 1, "scored", {})
}

test_financial_off_hours_requires_approval if {
	r := policy.result with input as mk("financial", 20, 1, "scored", {"off_hours": true, "local_hour": 3})
	r.decision == "approve"
	r.policy_name == "approve_financial_off_hours"
}

test_financial_off_hours_high_risk_blocks if {
	policy.decision == "block" with input as mk("financial", 75, 1, "scored", {"off_hours": true, "local_hour": 3})
}

test_unknown_tool_requires_approval if {
	r := policy.result with input as mk("unknown", 25, null, "skipped", {})
	r.decision == "approve"
	r.policy_name == "approve_unknown_tool"
}

test_prompt_injection_blocks_even_with_low_final_score if {
	r := policy.result with input as mk("communication", 20, 85, "scored", {})
	r.decision == "block"
	r.policy_name == "block_prompt_injection"
}

test_injection_below_threshold_does_not_block if {
	policy.decision == "allow" with input as mk("communication", 20, 79.9, "scored", {})
}

test_degraded_classifier_requires_approval if {
	r := policy.result with input as mk("communication", 50, null, "unavailable", {})
	r.decision == "approve"
	contains(r.policy_name, "approve_degraded_scoring")
}

test_duplicate_pending_blocks if {
	r := policy.result with input as mk("destructive", 60, 2, "scored", {"duplicate_pending_call_id": "0b8e3f4c-1d2e-4f5a-8b9c-0d1e2f3a4b5c"})
	r.decision == "block"
	r.policy_name == "block_duplicate_pending"
}

test_block_beats_approve if {
	r := policy.result with input as mk("destructive", 90, 95, "scored", {})
	r.decision == "block"
	r.policy_name == "block_high_risk_score, block_prompt_injection"
}

# --- fail closed on bad input

test_missing_input_denied if {
	r := policy.result with input as {}
	r.decision == "block"
	r.policy_name == "block_invalid_input"
}

test_non_numeric_score_denied if {
	inp := object.union(mk("communication", 10, 1, "scored", {}), {"risk": {"final_score": "10"}})
	policy.decision == "block" with input as inp
}

test_out_of_range_score_denied if {
	policy.decision == "block" with input as mk("communication", 150, 1, "scored", {})
}

test_negative_score_denied if {
	policy.decision == "block" with input as mk("communication", -1, 1, "scored", {})
}
