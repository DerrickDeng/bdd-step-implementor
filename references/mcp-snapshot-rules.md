# MCP Snapshot Reuse Rules

This document governs when to call `browser_snapshot` versus reusing an existing snapshot during the MCP attach workflow.

## Why snapshot discipline matters

Each `browser_snapshot` call adds latency and consumes context window. More importantly, redundant snapshots train a habit of "just take another one" that crowds out careful analysis of the snapshot already in hand. The attach workflow's value comes from precise observation, not from volume of observations.

## Core principle

**Default to the newest snapshot you already have.** Only request a new one when you can name the specific information that is missing.

## Before every explicit `browser_snapshot`, answer this checklist

1. Did the last MCP response already include a snapshot?
2. Did the URL or visible UI state materially change after that response?
3. Is the exact target or assertion state absent from that returned snapshot?

If the answers are `yes`, `no`, `no` — do not call `browser_snapshot`.

## Cross-step reuse

- If step `N` ended with an MCP response that included a snapshot, treat that snapshot as the starting point for step `N+1`.
- Merely reaching the next `wait-for-step.js` pause is not evidence that the page changed.
- If the URL is unchanged and the previous MCP response already shows the state needed for the next step, do not re-query the page just to "confirm" it again.

## Failed locator does not mean stale snapshot

A failed locator guess does not by itself make the previous snapshot stale. First reinterpret the existing snapshot before taking a new one. If the previous MCP response already exposed the needed `ref` or visible assertion target, stay on that response until you can name what concrete information is missing.

## Retry budget awareness

- Do not spend retries on "state confirmation" queries when the current snapshot already contains the exact element or assertion target you need.
- If the last MCP response already contains the visible target state, spend the retry on a better interpretation of that snapshot, not on `browser_snapshot`.

## When a `browser_evaluate` returns a snapshot

If a fallback `browser_evaluate` response returns a snapshot, reuse that snapshot immediately. Do not chain more diagnostic `browser_evaluate` calls or take a fresh `browser_snapshot` unless the returned snapshot is still insufficient.

## Preferred workflow summary

1. Start from the newest MCP-returned snapshot already in hand
2. If that snapshot is missing or genuinely stale, call `mcp__playwright-cdp__browser_snapshot`
3. Run a test-id scan via `mcp__playwright-cdp__browser_evaluate` using the discovery query below — `data-testid` attributes are not visible in the accessibility snapshot, so this scan is always needed
4. Prefer `getByTestId()` when a matching test-id is found for the target element
5. If no matching test-id, choose the target element by role/name/text from the snapshot
6. Write the smallest clear Playwright locator or assertion directly into `impl.js`
7. Let the stub execute the interaction — do not use MCP to perform it first

## Read-only fallback query examples

Use these only when the current snapshot genuinely lacks the information you need.

Fallback DOM query for discovering available test ids:

```javascript
() => Array.from(document.querySelectorAll('[data-testid]'))
  .map(el => ({
    testid: el.dataset.testid,
    tag: el.tagName,
    text: (el.textContent || '').trim().slice(0, 80)
  }))
```

Fallback locator validation pattern:

```javascript
() => {
  const el = document.querySelector('[data-testid="your-testid"]');
  return el ? {
    found: true,
    tag: el.tagName,
    text: (el.textContent || '').trim()
  } : { found: false };
}
```
