import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM helper
import { E2E, e2eEnv, root } from './env.mjs';

/**
 * The live demo script, automated (TRD §16 E2E): login -> overview -> demo scenarios ->
 * activity -> call detail -> approval -> audit verify -> tamper -> verify FAIL -> restore.
 * Everything runs against the real API, OPA, and Postgres; nothing is mocked.
 */
test.describe.configure({ mode: 'serial' });

const API = `http://127.0.0.1:${E2E.apiPort}`;

async function login(page: Page) {
  await page.goto('/login');
  await page.fill('#username', E2E.admin.username);
  await page.fill('#password', E2E.admin.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL(/\/$/);
}

async function trigger(page: Page, scenario: string) {
  await page.goto('/demo');
  const card = page.locator(`[data-scenario="${scenario}"]`);
  await card.getByRole('button', { name: /Trigger/ }).click();
  await expect(card.locator('[data-result-decision], [data-result-total]')).toBeVisible({ timeout: 30_000 });
  return card;
}

function tamperCli(args: string) {
  const r = spawnSync(`npx tsx apps/api/src/cli/tamper.ts ${args}`, { cwd: root, env: e2eEnv(), shell: true, encoding: 'utf8' });
  expect(r.status, r.stderr || r.stdout).toBe(0);
  return r.stdout;
}

async function agentCall(body: Record<string, unknown>) {
  const res = await fetch(`${API}/api/tool-call`, {
    method: 'POST',
    headers: { authorization: `Bearer ${E2E.agentKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as { call_id: string; decision: string };
}

test('unauthenticated visitors are redirected to /login (with return path)', async ({ page }) => {
  await page.goto('/approvals');
  await expect(page).toHaveURL(/\/login\?next=%2Fapprovals/);
  await expect(page.getByRole('heading', { name: 'AgentGuard' })).toBeVisible();
});

test('invalid login shows an inline error; valid login lands on Overview with real stats', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#username', E2E.admin.username);
  await page.fill('#password', 'wrong-password');
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Incorrect username or password.')).toBeVisible();
  await login(page);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  // Seeded history went through the real pipeline, so total is a real, non-zero count.
  const total = Number(await page.locator('[data-stat="total"]').innerText());
  expect(total).toBeGreaterThan(40);
  await expect(page.getByRole('img', { name: /Calls over the last 24h/ })).toBeVisible();
});

test('NORMAL scenario -> allowed and executed; visible in Activity and Call Detail', async ({ page }) => {
  await login(page);
  const card = await trigger(page, 'normal');
  await expect(card.locator('[data-status="allowed"]')).toBeVisible();
  await expect(card.getByText('Mock tool executed (sandboxed).')).toBeVisible();

  await page.goto('/activity');
  const firstRow = page.locator('tbody tr').first();
  await expect(firstRow).toContainText('send_email');
  await expect(firstRow).toContainText('demo-scenario-runner');
  await firstRow.click();
  await expect(page).toHaveURL(/\/calls\//);
  await expect(page.getByRole('heading', { name: 'Policy decision (OPA)' })).toBeVisible();
  await expect(page.getByText('allow_low_risk_score')).toBeVisible();
  await expect(page.locator('[data-executed="true"]')).toHaveText('Executed (sandboxed mock)');
  await expect(page.getByText('Rule checklist')).toBeVisible();
});

test('BULK DELETE -> pending; does not execute until a human approves it on /approvals', async ({ page }) => {
  await login(page);
  const card = await trigger(page, 'bulk-delete');
  await expect(card.locator('[data-status="pending"]')).toBeVisible();
  await expect(card.getByText('Waiting for a human on Approvals.')).toBeVisible();

  await page.goto('/approvals');
  const approval = page.locator('article', { hasText: '/srv/reports/2025/*' }).first();
  await expect(approval).toBeVisible();
  await expect(approval.getByText(/Auto-denies in/)).toBeVisible();
  await expect(approval.getByText('approve_destructive_action, approve_medium_risk_score')).toBeVisible();
  await approval.getByRole('link', { name: 'View full detail' }).click();
  await expect(page.getByText('Awaiting human approval')).toBeVisible();
  await expect(page.getByText('Not executed yet')).toBeVisible();
  await page.goBack();

  await page.locator('article', { hasText: '/srv/reports/2025/*' }).first().getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/Approved — the action was executed/)).toBeVisible();
  await expect(page.locator('article', { hasText: '/srv/reports/2025/*' })).toHaveCount(0);

  await page.goto('/activity?');
  await page.locator('tbody tr', { hasText: 'delete_file' }).first().click();
  await expect(page.locator('[data-executed="true"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Human approval' })).toBeVisible();
  await expect(page.getByText(E2E.admin.username, { exact: true })).toBeVisible();
});

test('PROMPT INJECTION -> blocked, tool not executed, reasoning shown', async ({ page }) => {
  await login(page);
  const card = await trigger(page, 'injection');
  await expect(card.locator('[data-status="blocked"]')).toBeVisible();
  await expect(card.getByText('Mock tool NOT executed.')).toBeVisible();
  await card.getByRole('link', { name: 'View call' }).click();
  await expect(page.locator('[data-executed="false"]')).toHaveText('Not executed');
  await expect(page.getByText(/at or above the block threshold/)).toBeVisible();
  await expect(page.getByText(/TF-IDF \+ logistic regression: P\(injection\)/)).toBeVisible();
});

test('UNUSUAL-HOUR PAYMENT -> routed to approval by the off-hours financial policy', async ({ page }) => {
  await login(page);
  const card = await trigger(page, 'unusual-hour-payment');
  await expect(card.locator('[data-status="pending"]')).toBeVisible();
  await expect(card.getByText(/approve_financial_off_hours/)).toBeVisible();
  await card.getByRole('link', { name: 'View call' }).click();
  await expect(page.getByText(/simulated time/)).toBeVisible();
  // Reject it so it doesn't linger.
  await page.goto('/approvals');
  const pay = page.locator('article', { hasText: 'Northwind Supplies Ltd' }).first();
  await pay.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Rejected — the action will not run.')).toBeVisible();
});

test('AUDIT LOG: verify PASS -> controlled tamper -> verify FAIL at that row -> restore -> PASS', async ({ page }) => {
  await login(page);
  await page.goto('/audit-log');
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(/PASS — chain valid/)).toBeVisible();

  const out = tamperCli('');
  const seq = Number(/TAMPERED audit row #(\d+)/.exec(out)![1]);
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(`FAIL — tampered row detected at #${seq}`)).toBeVisible();
  await page.getByRole('button', { name: `Show row #${seq}` }).click();
  await expect(page.locator(`tr[data-seq="${seq}"][data-broken]`)).toBeVisible();
  await expect(page.locator(`tr[data-seq="${seq}"]`).getByText('Tampered')).toBeVisible();

  tamperCli('--restore');
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(/PASS — chain valid/)).toBeVisible();
});

test('LIVE UPDATE: a new agent call appears in Activity without a reload', async ({ page }) => {
  await login(page);
  await page.goto('/activity');
  await expect(page.locator('[data-live-mode="live"]')).toBeVisible();
  const { call_id } = await agentCall({ tool_name: 'run_db_query', params: { query: 'SELECT 42 FROM live_update_probe LIMIT 1' } });
  await expect(page.locator(`tr[data-call-id="${call_id}"]`)).toBeVisible({ timeout: 5_000 });
});

test('LIVE APPROVALS: a newly escalated call appears in the Approvals queue without a reload', async ({ page }) => {
  await login(page);
  await page.goto('/approvals');
  await expect(page.locator('[data-live-mode="live"]')).toBeVisible();
  // Unknown tools always go to a human (approve_unknown_tool) whatever the real clock says.
  const { call_id } = await agentCall({ tool_name: 'archive_records', params: { collection: 'live-probe-records' } });
  const card = page.locator('article', { hasText: 'live-probe-records' });
  await expect(card).toBeVisible({ timeout: 5_000 });
  await card.getByRole('button', { name: 'Reject' }).click();
  await expect(card).toHaveCount(0);
  expect(call_id).toBeTruthy();
});

test('FALLBACK: with the live channel blocked the UI says so and keeps updating by polling', async ({ page }) => {
  await page.route('**/api/events', (route) => route.abort());
  await login(page);
  await page.goto('/activity');
  await expect(page.locator('[data-live-mode="polling"]')).toBeVisible();
  await expect(page.getByText(/Live channel lost — polling/)).toBeVisible();
  const { call_id } = await agentCall({ tool_name: 'run_db_query', params: { query: 'SELECT 7 FROM polling_probe LIMIT 1' } });
  await expect(page.locator(`tr[data-call-id="${call_id}"]`)).toBeVisible({ timeout: 8_000 });
});

test('XSS: hostile agent input is rendered as inert text', async ({ page }) => {
  let dialogFired = false;
  page.on('dialog', async (d) => {
    dialogFired = true;
    await d.dismiss();
  });
  const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const { call_id } = await agentCall({ tool_name: 'send_email', params: { to: 'a@acme.example', subject: xss, body: xss } });
  await login(page);
  await page.goto(`/calls/${call_id}`);
  await expect(page.getByTestId('raw-payload')).toContainText('<script>alert(2)</script>');
  expect(await page.locator('img[src="x"]').count()).toBe(0);
  expect(dialogFired).toBe(false);
});

test('BURST: 25 calls from the demo panel; dashboard stays responsive', async ({ page }) => {
  await login(page);
  const card = await trigger(page, 'burst');
  await expect(card.locator('[data-result-total="25"]')).toBeVisible();
  await expect(card.getByText(/25 calls · .* 0 failed/)).toBeVisible();
  await page.goto('/activity');
  await expect(page.locator('tbody tr')).toHaveCount(25);
  await page.goto('/');
  await expect(page.locator('[data-stat="total"]')).not.toHaveText('—');
});

test('logout revokes the session', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Log out' }).click();
  await expect(page).toHaveURL(/\/login/);
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});
