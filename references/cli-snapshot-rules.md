# CLI Snapshot Reuse Rules

This document governs when to call `$CLI snapshot` versus reusing an existing snapshot during the playwright-cli attach workflow.

## Why snapshot discipline matters

Every `$CLI snapshot` call has two costs: wall-clock time for the CLI to walk the a11y tree, and — worse — the tokens it takes to pull the result into context. An a11y snapshot of a real page can easily be thousands of lines of YAML. Redundant snapshots train a habit of "just take another one" that crowds out careful analysis of the snapshot already in hand, and if you forget `--filename`, every redundant snapshot also dumps the full YAML straight into the conversation.

## Always pass `--filename`

The `playwright-cli` snapshot command has two output modes:

- **With `--filename=<path>`**: writes the YAML to that file and prints only a link. This is what we want — the agent then `Read`s a targeted slice.
- **Without `--filename`**: prints the full YAML inline to stdout, which goes straight into the conversation. This wastes a huge amount of tokens on content you mostly don't need.

(Auto-snapshots that some commands emit — e.g. after `open` — already write to a file on their own; those are safe. The inline behavior only appears when you call the explicit `snapshot` subcommand without `--filename`.)

So every explicit snapshot in this workflow must look like:

```bash
$CLI snapshot --filename=.playwright-cli/step-<N>.yml
```

Use `step-<N>.yml` for the primary snapshot of step N. If during the same step you genuinely need a second snapshot after a state change, add a short suffix describing the change, e.g. `step-<N>-after-click.yml`, so you don't overwrite evidence you might still want to compare against.

## Core principle

**Default to the newest snapshot you already have.** Only request a new one when you can name the specific information that is missing.

## Token discipline when reading a snapshot file

The snapshot YAML can be long. Do NOT read the whole file.

1. On first read of a file, use `Read` with `limit: 80` to scan the top of the tree.
2. If the element you need isn't in the first 80 lines, use `Grep` on the file to find its `ref=` and surrounding context, then `Read` with `offset`/`limit` to fetch ~20 lines around it.
3. Never read the same snapshot file twice without `offset` — re-reading wastes context.

## Before every explicit `$CLI snapshot`, answer this checklist

1. Do I already have a snapshot file from this run whose URL matches the current paused step?
2. Did the URL or visible UI state materially change after that snapshot was captured?
3. Is the exact target or assertion state absent from that snapshot?

If the answers are `yes`, `no`, `no` — do not call `$CLI snapshot`.

## Cross-step reuse

- If step `N` ended with a snapshot file, treat that file as the starting point for step `N+1`.
- Merely reaching the next `wait-for-step.js` pause is not evidence that the page changed.
- If the URL is unchanged and the previous snapshot already shows the state needed for the next step, do not re-query the page just to "confirm" it again.

## Failed locator does not mean stale snapshot

A failed locator guess does not by itself make the previous snapshot stale. First reinterpret the existing snapshot before taking a new one. If it already exposed the needed `ref` or visible assertion target, stay on that file until you can name what concrete information is missing.

## Retry budget awareness

- Do not spend retries on "state confirmation" queries when the current snapshot already contains the exact element or assertion target you need.
- If the last snapshot already contains the visible target state, spend the retry on a better interpretation of that snapshot, not on another `$CLI snapshot`.

## When `$CLI eval` returns a snapshot-like payload

If a fallback `$CLI eval` response returns enough DOM context for your purpose, reuse it immediately. Do not chain more `$CLI eval` calls or take a fresh snapshot unless the returned data is still insufficient.

## Preferred workflow summary

1. Start from the newest snapshot file already on disk for this run
2. If that file is missing or genuinely stale, call `$CLI snapshot --filename=.playwright-cli/step-<N>.yml` and `Read` a targeted slice
3. Run a test-id scan via `$CLI eval` using the discovery query below — `data-testid` attributes are not visible in the accessibility snapshot, so this scan is always needed
4. Prefer `getByTestId()` when a matching test-id is found for the target element
5. If no matching test-id, choose the target element by role/name/text from the snapshot
6. Write the smallest clear Playwright locator or assertion directly into `impl.js`
7. Let the stub execute the interaction — do not use `$CLI click` / `$CLI type` / etc. to perform it first

## Read-only fallback query examples

Use these only when the current snapshot genuinely lacks the information you need.

Fallback DOM query for discovering available test ids:

```bash
$CLI eval "() => Array.from(document.querySelectorAll('[data-testid]')).map(el => ({testid: el.dataset.testid, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 80)}))"
```

Fallback locator validation pattern:

```bash
$CLI eval "() => { const el = document.querySelector('[data-testid=\"your-testid\"]'); return el ? { found: true, tag: el.tagName, text: (el.textContent || '').trim() } : { found: false }; }"
```
