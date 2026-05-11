# Retry Policy and Failure Handling

This document covers retry rules, failure diagnosis, deadline management, and the run restart protocol for the MCP attach workflow. Read it when a step fails in Phase 3 and you need to decide how to respond.

---

## Retry Rules

Retry up to 6 times per step.

**Diagnose before fixing.** Before writing any fix, state your hypothesis for *why* it failed — not just *what* failed. The error message often points to a symptom, not the cause. "Element not found" could mean wrong locator, wrong page, content loaded async, or a case error.

**Stay aware of your fix pattern.** Be honest — are you actually trying something different, or just making minor variations on the same idea? If you're tweaking locators repeatedly, consciously switch dimension: re-examine the snapshot, question whether the problem is somewhere else entirely (wrong page, async loading, scenario error).

**Certain vs uncertain failures.** If a snapshot has already proven the content is absent on the correct page, that is a **certain case error** — skip remaining iterations and jump to the blocked state. The 6-iteration limit exists for *uncertain* situations; burning extra iterations after proof of absence is the exact failure mode to avoid.

---

## Failure Categories

| Category | Signal | Action |
|----------|--------|--------|
| Wrong locator | "element not found", "strict mode violation" | Re-check the snapshot, regenerate the locator from `ref`, and rewrite |
| Assertion mismatch | `expect()` failure with actual vs expected | Take a fresh snapshot to inspect real text/structure on the paused page |
| Syntax / require error | `SyntaxError`, `Cannot find module` | Rewrite `impl.js` |
| Case error | MCP confirms expected content is absent | Stop and report immediately — do not burn retries |
| Dirty page state | Failed `impl.js` mutated the page | Restart the background run via the run restart protocol, then return to step A |

The accessibility snapshot is the primary diagnosis tool. A screenshot adds visual context that the snapshot cannot express, and at the right moment it can cut a debug cycle short. Use `$CLI screenshot` when:

- The element appears in the snapshot but the locator still fails after 2+ retries — the page may have an overlay, a sticky header, or the element may be clipped off-screen
- A step times out — screenshot shows what the page looked like at the deadline (loading spinner? modal? blank area?)
- An assertion fails but the snapshot looks correct — the rendered text or visibility may differ from what the accessibility tree reports
- The failure is ambiguous between a locator problem and a page-state problem — one screenshot often resolves the ambiguity immediately
- After a restart, before writing the first `impl.js` — visual confirmation that the page is in the expected state

**Do not take a screenshot when:**

- The snapshot already clearly shows the element and the locator is straightforward — screenshot adds no information
- You are about to write a first-pass `impl.js` with no prior failure — try snapshot-derived locators first

---

## Multi-Row Failure Diagnosis (Scenario Outline)

If the error identifies a specific Examples row, use MCP to inspect the paused page for that row. Compare what MCP shows against the expected content. Look for differences in element structure across rows (e.g., one row's keyword is a heading while another is plain text inside a `<div>`).

---

## Deadline Management

Check `runDeadlineAt` from the pause JSON against the current time:

| Remaining time | Action |
|----------------|--------|
| >= 90 seconds | Continue normally |
| < 90 seconds | Finish the current straightforward step if already paused, but do not begin another exploratory retry loop |
| < 30 seconds | Stop at the next safe step boundary and restart |

---

## Other Retry Rules

- If a repeated step text appears later in the queue, never reuse the earlier step's `impl.js` by text similarity. Reuse only after the later pause JSON proves the same page state and the same interaction are valid.
- If a snapshot exposes a usable `ref`, do not fall back to ad-hoc DOM queries just to invent a different selector.

---

## Blocked Protocol

After 6 failed iterations, report the following and wait for the user:

```text
STEP BLOCKED — 6 iterations failed

Step: "<step text>"
Last error: <error message>
Current impl: <impl.js content>
Fix history: [1] ... [2] ... [3] ...

Fix manually, then reply "fixed" to continue.
```

After the user responds, continue from the result-wait step.

---

## Run Restart Protocol

When you need to restart because of timeout pressure, dirty page state, or port conflict:

```bash
node "$SKILL_DIR/scripts/stop-run.js" --clean-port --port 9222
node "$SKILL_DIR/scripts/start-run.js" \
  --port 9222 \
  --log test-results/mcp-step.log \
  --step-count {queue_length} \
  --clean-port \
  -- {attach_command}
```

The new run will auto-restore validated impls from the previous run when the command matches. Do not manually copy `step-1-impl.js`, `step-2-impl.js`, etc. unless that auto-restore failed and you have confirmed why.

Never start a second raw attach run while the first run still owns 9222.
