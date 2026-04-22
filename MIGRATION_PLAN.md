# MCP → playwright-cli Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `playwright-cdp` MCP server with the `playwright-cli` CLI (v0.1.8+) as the browser-observation layer in the `bdd-step-implementor` skill, while preserving the cucumber-launched, CDP-attached, observation-only contract.

**Architecture:**
- Cucumber continues to launch Chromium with `--remote-debugging-port=9222` in `BeforeAll`.
- `start-run.js` additionally resolves the browser's `webSocketDebuggerUrl` from `http://127.0.0.1:<port>/json/version` (http endpoint is bugged in CLI 0.1.8) and writes it to `mcp-bridge/<runId>/cdp-ws.txt`.
- In Phase 3B the Claude agent attaches the playwright-cli daemon to that ws URL once per run (`playwright-cli attach --cdp="$(cat ...cdp-ws.txt)"`).
- All observation (`snapshot`, `eval`, `tab-list`, `screenshot`) is then shell commands against the attached daemon. Snapshots land as YAML files under `.playwright-cli/` — only paths enter the LLM context, the agent reads targeted slices on demand via the `Read` tool.
- `playwright-test` MCP is retained for users who want it for other skills; only `playwright-cdp` is removed.

**Tech Stack:** Node.js ≥ 18, `@playwright/cli@>=0.1.8`, cucumber-js, bash.

---

## Part 0 — Background Analysis (read first)

### 0.1 Why migrate

MCP `playwright-cdp` is functionally equivalent to `playwright-cli attach --cdp=<ws>` but carries three token costs the CLI path avoids:

| Cost | MCP | CLI |
|---|---|---|
| Persistent tool schemas | ~20 tool schemas loaded into every conversation | zero |
| `browser_snapshot` reply | Full a11y YAML inlined (~500–3000 tokens/call) | File path only (~20 tokens) |
| `browser_evaluate` / screenshot replies | Inline results / base64 | File path / stdout, readable on demand |

Empirical validation (TodoMVC homepage, run on 2026-04-21):
- CLI `snapshot` reply: 76 bytes
- MCP `browser_snapshot` reply: 690 bytes
- Snapshot **content** identical (same `ref=e1..e14`, role, name, cursor, url fields)
- Process check: CLI `attach` spawns only a node daemon (pid 7278 in test), does not spawn a new Chromium.

For a 5-step scenario averaging 2 snapshots + 1 testid scan per step, expected savings are 15k–30k tokens per run on top of MCP's always-loaded schema baseline.

### 0.2 What the current skill depends on

MCP surface used by the skill:
1. `mcp__playwright-cdp__browser_tabs` — identity verification (Phase 3B)
2. `mcp__playwright-cdp__browser_snapshot` — primary observation (Phase 3C, every step)
3. `mcp__playwright-cdp__browser_evaluate` — testid scan + fallback DOM queries (Phase 3C)
4. `mcp__playwright-cdp__browser_take_screenshot` — diagnostic (Phase 3F, retry-policy)

MCP surface **not** used and irrelevant to migration: `browser_click`, `browser_type`, etc. — skill is observation-only by contract (see SKILL.md §Key Principles #2: "MCP observes, stubs execute").

### 0.3 Migration surface — file-by-file impact

| File | Change type | Notes |
|---|---|---|
| `.mcp.json` (project) | **Edit** | Delete `playwright-cdp` entry, keep `playwright-test` |
| `.claude/project-profile.json` (project) | **Edit** | Add `cli_snapshot_dir: ".playwright-cli"` (optional), bump `version` |
| `SKILL.md` | **Rewrite Phase 3B/C/D; update frontmatter** | ~40% of file touches MCP tool names |
| `references/mcp-snapshot-rules.md` | **Rename + rewrite** → `cli-snapshot-rules.md` | File name and every example |
| `references/retry-policy.md` | **Edit** | Screenshot trigger section |
| `references/prerequisites.md` | **Edit** | Delete "Section 3: MCP Configuration" doctor content; add new §"playwright-cli Installation"; update LLM Verification Check 2 |
| `references/code-patterns.md` | **No change** | Does not reference MCP tools |
| `references/phase4-finalization.md` | **No change** | Does not reference MCP tools |
| `references/scenario-outline.md` | **Edit** | One reference to `mcp-snapshot-rules.md` — update path |
| `scripts/start-run.js` | **Edit** | Resolve ws URL, write `cdp-ws.txt`, verify `playwright-cli` on PATH |
| `scripts/stop-run.js` | **Edit** | Also run `playwright-cli close-all` on the bound session |
| `scripts/setup.js` | **Edit** | Remove MCP attach-server patching; add `npm ls -g @playwright/cli` check |
| `scripts/doctor-lib.js` | **Edit** | Replace `mcp-config` check with `playwright-cli-installed` + `playwright-cli-version >= 0.1.8` |
| `scripts/discover-project.js` | **Edit** | Stop emitting MCP guidance in output; update the LLM-verification hint text |
| `scripts/resolve-skill-path.js` | **Edit** | Fix latent bug — it still hard-codes `mcp-step-implementor` while the dir is `bdd-step-implementor` |
| `scripts/cleanup.js`, `generate-stubs.js`, `wait-for-{step,result}.js`, `quality-gate-check.js`, `feature-baseline-hash.js`, `platform-runner.js`, `run-watchdog.js`, `run-manifest.js`, `timeout-policy.js`, `windows-launch.js`, `fs-utils.js` | **No functional change** | Grep confirms no MCP dependency. `mcp-bridge/` directory name is kept (internal contract, not MCP-related) |
| `evals/test-plan-edge-cases.md` | **Review** | Update any MCP-tool references in eval prompts |

### 0.4 Known CLI quirks to design around

1. **http endpoint bug**: `playwright-cli attach --cdp=http://127.0.0.1:9222` fails with `Unexpected status 400 when connecting to http://127.0.0.1:9222/json/version/`. The CLI probes `/json/version/` (trailing slash) which modern Chrome rejects with 400. Workaround: always pass the `ws://...` URL (extracted from `http://.../json/version` JSON `webSocketDebuggerUrl`). This is centralized in `start-run.js`.
2. **Daemon lifetime**: `playwright-cli attach` spawns a long-lived node daemon (`cliDaemon.js`). Multiple attaches to the same session reuse it. The daemon must be closed at run-end via `playwright-cli close` or `close-all`, otherwise the next run's attach is rejected ("already open").
3. **Session scoping**: CLI sessions are per-name via `-s=<name>`. We will use `-s=bdd-<runId>` so parallel skills don't collide.
4. **`run-code` vs `eval`**: `eval` expects a **page-scoped function** (runs in `page.evaluate(...)`, has `document`, `window`). `run-code` expects **Playwright API code** (has `page`, no `document`). The skill's testid-discovery query uses `document.querySelectorAll` and therefore always uses `eval`.
5. **`--raw`**: strips the `### Result` wrapper. Useful in scripts; leave it OFF for SKILL.md examples because the wrapper doubles as an audit trail ("Ran Playwright code" section documents what was actually executed).

### 0.5 Out-of-scope for this plan

- Replacing the `mcp-bridge/` protocol with `playwright-cli pause-at` / `resume`. CLI 0.1.8 has these commands but they drive CLI's own suspension, not arbitrary Cucumber stubs. Proven infeasible without rewriting the stub protocol; deferred to a separate future investigation.
- Migrating `playwright-test` MCP. Out of scope — this plan only removes `playwright-cdp`.

---

## Part 1 — Implementation Tasks

### Task 1: Prepare working tree

**Files:**
- Create: `/Users/dengzicheng/repository/claude_playwright/.claude/skills/bdd-step-implementor/MIGRATION_PLAN.md` (this file; already created)

- [ ] **Step 1: Create migration worktree**

```bash
cd /Users/dengzicheng/repository/claude_playwright
git status  # expect: clean
git checkout -b migration/mcp-to-playwright-cli
```

- [ ] **Step 2: Snapshot the pre-migration SKILL.md to compare diff size later**

```bash
cp .claude/skills/bdd-step-implementor/SKILL.md /tmp/SKILL.md.pre-migration
wc -l /tmp/SKILL.md.pre-migration  # expect: 747
```

- [ ] **Step 3: Commit the plan as the first migration commit**

```bash
git add .claude/skills/bdd-step-implementor/MIGRATION_PLAN.md
git commit -m "plan: migrate bdd-step-implementor from playwright-cdp MCP to playwright-cli"
```

---

### Task 2: Add ws-URL resolution to `start-run.js`

**Goal:** `start-run.js` must discover the `webSocketDebuggerUrl` after the test process launches (once the CDP port is listening) and write it to `mcp-bridge/<runId>/cdp-ws.txt`. All later shell invocations of `playwright-cli attach` read from this file.

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/scripts/start-run.js`
- Test: `.claude/skills/bdd-step-implementor/scripts/__tests__/start-run.ws-url.test.js` (new; uses a simple local http server mocking `/json/version`)

- [ ] **Step 1: Write failing test**

Create `.claude/skills/bdd-step-implementor/scripts/__tests__/start-run.ws-url.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { resolveWsUrl } = require('../start-run');  // new export

test('resolveWsUrl extracts webSocketDebuggerUrl from /json/version', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        Browser: 'Chrome/147.0',
        webSocketDebuggerUrl: 'ws://127.0.0.1:0/devtools/browser/abc-123',
      }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ws = await resolveWsUrl(`http://127.0.0.1:${port}`, { timeoutMs: 2000 });
    assert.strictEqual(ws, 'ws://127.0.0.1:0/devtools/browser/abc-123');
  } finally {
    server.close();
  }
});

test('resolveWsUrl retries until endpoint is up then succeeds', async () => {
  // Start no server; start one after 300ms; resolver with 3s budget should succeed.
  let server;
  const started = new Promise((resolve) => {
    setTimeout(() => {
      server = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://x/y' }));
      });
      server.listen(39222, '127.0.0.1', resolve);
    }, 300);
  });
  try {
    const ws = await resolveWsUrl('http://127.0.0.1:39222', { timeoutMs: 3000, pollIntervalMs: 100 });
    assert.strictEqual(ws, 'ws://x/y');
  } finally {
    await started;
    server && server.close();
  }
});
```

- [ ] **Step 2: Run the tests; expect failures**

```bash
cd /Users/dengzicheng/repository/claude_playwright
node --test .claude/skills/bdd-step-implementor/scripts/__tests__/start-run.ws-url.test.js
```
Expected: both tests fail with `TypeError: resolveWsUrl is not a function` (not yet exported).

- [ ] **Step 3: Implement `resolveWsUrl` in `start-run.js` and export it**

In `.claude/skills/bdd-step-implementor/scripts/start-run.js`, add near the top (after other requires):

```javascript
async function resolveWsUrl(httpBase, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30000;
  const pollIntervalMs = opts.pollIntervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  const url = `${httpBase.replace(/\/+$/, '')}/json/version`;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        const body = await res.json();
        if (typeof body.webSocketDebuggerUrl === 'string') {
          return body.webSocketDebuggerUrl;
        }
        throw new Error('webSocketDebuggerUrl missing in /json/version response');
      }
      lastErr = new Error(`/json/version returned ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  throw new Error(`Timed out resolving ws URL from ${url}: ${lastErr?.message || 'unknown error'}`);
}

module.exports = { ...module.exports, resolveWsUrl };
```

- [ ] **Step 4: Run tests; expect PASS**

```bash
node --test .claude/skills/bdd-step-implementor/scripts/__tests__/start-run.ws-url.test.js
```
Expected: `# pass 2`, `# fail 0`.

- [ ] **Step 5: Wire resolution into the launcher main flow**

Find the section in `start-run.js` that writes `mcp-bridge/<runId>/launch.json` after the cucumber child process is spawned. Immediately after the launch manifest is written (so the run is discoverable), add:

```javascript
const wsUrl = await resolveWsUrl(`http://127.0.0.1:${port}`, { timeoutMs: 30000 });
fs.writeFileSync(path.join(runDir, 'cdp-ws.txt'), wsUrl + '\n');
console.log(`[start-run] cdp ws url -> ${path.join(runDir, 'cdp-ws.txt')}`);
```

Import `fs` and `path` if not already. Place this call inside the existing async flow; if `start-run.js` is not already async at the top level, wrap the main routine in an async IIFE.

- [ ] **Step 6: Guard against resolution failure**

If `resolveWsUrl` throws, it must terminate the run cleanly (kill the spawned cucumber process, clean the port, exit non-zero) so the agent sees a fast, clear failure instead of a downstream attach error 30 seconds later. Add:

```javascript
try {
  const wsUrl = await resolveWsUrl(`http://127.0.0.1:${port}`, { timeoutMs: 30000 });
  fs.writeFileSync(path.join(runDir, 'cdp-ws.txt'), wsUrl + '\n');
} catch (err) {
  console.error(`[start-run] failed to resolve CDP ws url: ${err.message}`);
  try { process.kill(launchPid, 'SIGTERM'); } catch (_) {}
  fs.writeFileSync(
    path.join(runDir, 'launch-failure.json'),
    JSON.stringify({ kind: 'ws-url-resolution', error: err.message }, null, 2),
  );
  process.exit(1);
}
```

Replace `launchPid` with the actual variable name used in the file.

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/bdd-step-implementor/scripts/start-run.js \
        .claude/skills/bdd-step-implementor/scripts/__tests__/
git commit -m "feat(start-run): resolve CDP ws url and persist to mcp-bridge/<runId>/cdp-ws.txt"
```

---

### Task 3: Teach `stop-run.js` to close the CLI daemon

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/scripts/stop-run.js`

- [ ] **Step 1: Read the current file**

```bash
cat .claude/skills/bdd-step-implementor/scripts/stop-run.js
```

- [ ] **Step 2: Add CLI cleanup**

At the end of the existing cleanup sequence (after the cucumber process is killed but before port cleanup), add:

```javascript
function closeCliDaemon(runId) {
  const sessionName = `bdd-${runId}`;
  const result = require('child_process').spawnSync(
    'playwright-cli',
    ['-s', sessionName, 'close'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) {
    // Session may not exist (run never attached) — swallow silently
    if (!/is not open/i.test(result.stderr || '')) {
      console.warn(`[stop-run] playwright-cli close returned ${result.status}: ${result.stderr?.trim()}`);
    }
  }
}
```

Call `closeCliDaemon(runId)` immediately after the cucumber process is killed.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/bdd-step-implementor/scripts/stop-run.js
git commit -m "feat(stop-run): close playwright-cli daemon on run teardown"
```

---

### Task 4: Swap doctor/setup from MCP check to CLI check

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/scripts/doctor-lib.js`
- Modify: `.claude/skills/bdd-step-implementor/scripts/setup.js`
- Test: `.claude/skills/bdd-step-implementor/scripts/__tests__/doctor.cli.test.js` (new)

- [ ] **Step 1: Write failing tests**

Create `.claude/skills/bdd-step-implementor/scripts/__tests__/doctor.cli.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const { checkPlaywrightCliInstalled } = require('../doctor-lib');

test('checkPlaywrightCliInstalled accepts 0.1.8', () => {
  assert.deepStrictEqual(checkPlaywrightCliInstalled({ simulate: '0.1.8' }), { ok: true, version: '0.1.8' });
});

test('checkPlaywrightCliInstalled accepts 0.2.0', () => {
  assert.deepStrictEqual(checkPlaywrightCliInstalled({ simulate: '0.2.0' }), { ok: true, version: '0.2.0' });
});

test('checkPlaywrightCliInstalled rejects 0.1.7', () => {
  const result = checkPlaywrightCliInstalled({ simulate: '0.1.7' });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, />= 0\.1\.8/);
});

test('checkPlaywrightCliInstalled rejects missing binary', () => {
  const result = checkPlaywrightCliInstalled({ simulate: null });
  assert.strictEqual(result.ok, false);
  assert.match(result.reason, /not installed/i);
});
```

- [ ] **Step 2: Run tests; expect import failures**

```bash
node --test .claude/skills/bdd-step-implementor/scripts/__tests__/doctor.cli.test.js
```
Expected: tests fail with `TypeError: checkPlaywrightCliInstalled is not a function`.

- [ ] **Step 3: Implement the check in `doctor-lib.js`**

Add near the top of `doctor-lib.js`:

```javascript
function checkPlaywrightCliInstalled(opts = {}) {
  const MIN = [0, 1, 8];
  let version = opts.simulate;
  if (version === undefined) {
    try {
      const out = require('child_process').spawnSync('playwright-cli', ['--version'], { encoding: 'utf8' });
      if (out.status === 0) {
        const m = (out.stdout || '').trim().match(/^(\d+\.\d+\.\d+)/);
        version = m ? m[1] : null;
      } else {
        version = null;
      }
    } catch (_) {
      version = null;
    }
  }
  if (!version) {
    return { ok: false, reason: 'playwright-cli is not installed. Install with: npm install -g @playwright/cli@latest' };
  }
  const parts = version.split(/[.\-]/).map((n) => parseInt(n, 10));
  const cmp = [0, 1, 2].reduce((acc, i) => acc || ((parts[i] || 0) - MIN[i]), 0);
  if (cmp < 0) {
    return { ok: false, version, reason: `playwright-cli ${version} is older than required >= 0.1.8. Upgrade with: npm install -g @playwright/cli@latest` };
  }
  return { ok: true, version };
}

module.exports.checkPlaywrightCliInstalled = checkPlaywrightCliInstalled;
```

- [ ] **Step 4: Run tests; expect PASS**

```bash
node --test .claude/skills/bdd-step-implementor/scripts/__tests__/doctor.cli.test.js
```
Expected: `# pass 4`, `# fail 0`.

- [ ] **Step 5: Replace the `mcp-config` check in `inspectPrereqs`**

In `doctor-lib.js`, find the block that calls `addCheck(checks, 'mcp-config', ...)`. Delete it entirely. Also delete the `playwright-cli` check block that tests `npx playwright run-mcp-server --help` (that feature is no longer used by this skill). Delete `DEFAULT_ATTACH_SERVER` export from doctor-lib and the associated validator functions (the `checkMcpConfig`/`hasAttachServer` helpers).

Replace with:

```javascript
const cliCheck = checkPlaywrightCliInstalled();
addCheck(
  checks,
  'playwright-cli',
  'playwright-cli >= 0.1.8 installed',
  cliCheck.ok,
  'manual-required',
  cliCheck.ok ? null : cliCheck.reason,
  'npm install -g @playwright/cli@latest',
);
```

- [ ] **Step 6: Remove MCP patching from `setup.js`**

In `setup.js`:
- Delete the `ensureMcpConfig` function entirely.
- Delete its call from the main function.
- Delete the import of `DEFAULT_ATTACH_SERVER` (no longer exists).
- Keep `ensureGitignoreEntries` (it adds `mcp-bridge/` — the bridge directory name we keep).

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/bdd-step-implementor/scripts/doctor-lib.js \
        .claude/skills/bdd-step-implementor/scripts/setup.js \
        .claude/skills/bdd-step-implementor/scripts/__tests__/
git commit -m "refactor(doctor,setup): replace MCP check with playwright-cli check"
```

---

### Task 5: Clean MCP references from `discover-project.js`

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/scripts/discover-project.js`

- [ ] **Step 1: Find every MCP reference**

```bash
grep -n "mcp\|MCP\|run-mcp-server\|--caps" .claude/skills/bdd-step-implementor/scripts/discover-project.js
```
Expect ~5 hits: the `_mcp-stubs.steps.ts` filename (keep — it's the stub file naming convention), the LLM-verification console output (replace), and the doctor-run integration output (update).

- [ ] **Step 2: Update LLM verification hint output**

Around line 836-838, replace:
```
  console.log('  ✓ Check 1: Hooks semantic (BeforeAll/AfterAll, CDP port)');
  console.log('  ✓ Check 2: MCP config semantic (--caps=testing, proxy bypass)');
  console.log('  ✓ Check 3: Project profile consistency');
```
With:
```
  console.log('  ✓ Check 1: Hooks semantic (BeforeAll/AfterAll, CDP port)');
  console.log('  ✓ Check 2: playwright-cli install + version');
  console.log('  ✓ Check 3: Project profile consistency');
```

- [ ] **Step 3: Keep `_mcp-stubs.steps.ts` filename as-is**

That string refers to a stub file inside the user's project and is internal to the skill's bridge protocol. Renaming it would create churn with no functional benefit and break auto-restore of pre-validated impls. Leave alone.

- [ ] **Step 4: Run the discovery script against this repo to verify output still makes sense**

```bash
cd /Users/dengzicheng/repository/claude_playwright
node .claude/skills/bdd-step-implementor/scripts/discover-project.js --force 2>&1 | tail -20
```
Expected: no crashes; output mentions `playwright-cli install + version` in the doctor hint block.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/bdd-step-implementor/scripts/discover-project.js
git commit -m "chore(discover): update LLM-verification hint to reference playwright-cli"
```

---

### Task 6: Fix the latent skill-name bug in `resolve-skill-path.js`

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/scripts/resolve-skill-path.js`

The current script hard-codes `const skillName = 'mcp-step-implementor';`, but the actual directory is `bdd-step-implementor`. This means any path resolution that falls through to `.claude/skills/<name>/` search misses the real location. Fix it as part of this migration since we're already touching the skill's identity.

- [ ] **Step 1: Decide canonical skill name**

Keep `bdd-step-implementor` as the directory name (existing). Update `resolve-skill-path.js` to search for it.

- [ ] **Step 2: Edit**

```bash
sed -i '' "s/'mcp-step-implementor'/'bdd-step-implementor'/g" .claude/skills/bdd-step-implementor/scripts/resolve-skill-path.js
```

Also update comments on lines 7, 15-18, and the error message on line 82.

- [ ] **Step 3: Verify**

```bash
cd /tmp && node /Users/dengzicheng/repository/claude_playwright/.claude/skills/bdd-step-implementor/scripts/resolve-skill-path.js
```
Expected: prints `/Users/dengzicheng/repository/claude_playwright/.claude/skills/bdd-step-implementor`.

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/bdd-step-implementor/scripts/resolve-skill-path.js
git commit -m "fix(resolve-skill-path): use bdd-step-implementor as skill name"
```

---

### Task 7: Rewrite SKILL.md Phase 3B (attach & identity)

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/SKILL.md`

- [ ] **Step 1: Update the frontmatter `name` and `description`**

Open SKILL.md. Replace the frontmatter:

```markdown
---
name: bdd-step-implementor
description: Implement Cucumber BDD steps by attaching playwright-cli to the live Chromium browser launched by Cucumber — observing the real page at each paused step to write accurate locators and assertions. Use this skill whenever the user wants to implement Cucumber steps, add step definitions, create page object methods for BDD scenarios, or says things like "implement the steps", "make this feature file work", "write the step definitions", "implement this scenario". This skill uses real-time browser observation (playwright-cli attach via CDP) for higher-quality locator analysis than static HTML snapshots, and avoids token overhead of the MCP server by writing snapshots to files and letting the agent read them on demand.
---
```

Update the `# MCP Step Implementor` heading on line 6 to `# BDD Step Implementor`.

Also update the introductory paragraph on line 8:
> `This skill defines the attach workflow for implementing Cucumber BDD steps with playwright-cli on the live browser launched by Cucumber.`

- [ ] **Step 2: Rewrite Phase 3B subsection "Attach MCP to the live browser and confirm identity"**

Replace the subsection heading and body (currently lines 485-505) with:

````markdown
#### B. Attach playwright-cli to the live browser and confirm identity

Use `playwright-cli` exclusively in this phase. The `playwright-test` MCP is not valid here — it would launch a new Chromium process and cannot see the paused Cucumber session.

Attach once per run:

```bash
WS=$(cat mcp-bridge/$(node -p "require('./mcp-bridge/latest-run.json').runId")/cdp-ws.txt)
playwright-cli -s="bdd-$(node -p "require('./mcp-bridge/latest-run.json').runId")" attach --cdp="$WS"
```

This spawns a persistent node daemon bound to that run's session. All subsequent `playwright-cli` invocations in Phase 3 must pass the same `-s=...` flag to reach the daemon.

For convenience, define a shell variable at the start of Phase 3:

```bash
RUN_ID=$(node -p "require('./mcp-bridge/latest-run.json').runId")
CLI="playwright-cli -s=bdd-$RUN_ID"
```

Then:
- `$CLI tab-list` — list pages on the attached browser
- `$CLI snapshot` — capture a11y tree to `.playwright-cli/page-<timestamp>.yml`
- `$CLI eval "<fn>"` — run a page-scoped JS function, result returned inline (small) or in JSON block (structured)
- `$CLI screenshot` — take a screenshot

**Identity check before any locator work:**

1. `$CLI tab-list` and inspect the tabs
2. Select the tab whose URL matches the paused step's `step-N-pause.json#url`. If not already current, call `$CLI tab-select <index>`
3. `$CLI snapshot` — this writes a file; read a small slice via `Read` tool with `offset`/`limit` to confirm the visible content matches the paused step context
4. If the browser is showing a different page or a different process, stop. Do not continue.
````

- [ ] **Step 3: Rewrite Phase 3C — replace MCP tool names with CLI invocations**

Currently lines 506-538. Key rewrites:
- `mcp__playwright-cdp__browser_snapshot` → `$CLI snapshot` (writes YAML file; read targeted slices with `Read` tool, do NOT read the whole file)
- `mcp__playwright-cdp__browser_evaluate` → `$CLI eval "<fn>"` (result comes inline as `### Result` block)
- `mcp__playwright-cdp__browser_take_screenshot` → `$CLI screenshot` (writes PNG file; use `Read` tool to view)
- `mcp__playwright-cdp__browser_generate_locator` → not available in playwright-cli; keep the existing rule ("do not use") but drop the tool-specific reference

Add a new paragraph under "Practical defaults":

> **Token discipline.** `$CLI snapshot` returns a file path, not the snapshot content. Use `Read` with `offset` and `limit` to load only the region around the relevant element. Do not cat the whole file into context. Re-read only when the page has materially changed.

- [ ] **Step 4: Rewrite Phase 3D pre-write checklist reference path**

Line 523: update `references/mcp-snapshot-rules.md` → `references/cli-snapshot-rules.md` (file will be renamed in Task 9).

- [ ] **Step 5: Sanity-check the rewritten SKILL.md**

```bash
# No stale MCP-tool names should remain in Phase 3
sed -n '/^## Phase 3:/,/^## Phase 4:/p' .claude/skills/bdd-step-implementor/SKILL.md | grep -c "mcp__playwright-cdp"
```
Expected: `0`.

```bash
# File length should be roughly similar (not ballooning)
wc -l .claude/skills/bdd-step-implementor/SKILL.md
```
Expected: 720–760 lines (was 747).

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/bdd-step-implementor/SKILL.md
git commit -m "docs(SKILL): rewrite Phase 3B/C/D for playwright-cli attach"
```

---

### Task 8: Update `references/retry-policy.md`

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/references/retry-policy.md`

- [ ] **Step 1: Replace MCP screenshot reference**

Line 29 currently: `Use \`mcp__playwright-cdp__browser_take_screenshot\` when:`
Change to: `Use \`$CLI screenshot\` when:` (where `$CLI` is the variable defined in Phase 3B).

Also update line 634's `mcp__playwright-cdp__browser_take_screenshot` reference in `SKILL.md` — wait, that was already done in Task 7. Double-check no stale references remain:

```bash
grep -n "mcp__playwright-cdp" .claude/skills/bdd-step-implementor/references/retry-policy.md .claude/skills/bdd-step-implementor/SKILL.md
```
Expected: no matches.

- [ ] **Step 2: Commit**

```bash
git add .claude/skills/bdd-step-implementor/references/retry-policy.md
git commit -m "docs(retry-policy): replace MCP screenshot tool with playwright-cli"
```

---

### Task 9: Rename and rewrite `references/mcp-snapshot-rules.md` → `cli-snapshot-rules.md`

**Files:**
- Delete: `.claude/skills/bdd-step-implementor/references/mcp-snapshot-rules.md`
- Create: `.claude/skills/bdd-step-implementor/references/cli-snapshot-rules.md`
- Modify: `.claude/skills/bdd-step-implementor/references/scenario-outline.md` (reference path)
- Modify: `.claude/skills/bdd-step-implementor/SKILL.md` (reference path — already done in Task 7 step 4, but verify)

- [ ] **Step 1: Write the new `cli-snapshot-rules.md`**

Full contents:

````markdown
# CLI Snapshot Reuse Rules

This document governs when to call `$CLI snapshot` versus reusing an existing snapshot during the playwright-cli attach workflow.

## Why snapshot discipline matters

`$CLI snapshot` writes a YAML file and returns only the path. But each snapshot still has a cost: wall-clock time, and the future `Read` calls that pull its content into context. Redundant snapshots train a habit of "just take another one" that crowds out careful analysis of the snapshot already in hand.

## Core principle

**Default to the newest snapshot you already have.** Only request a new one when you can name the specific information that is missing.

## Token discipline when reading a snapshot file

`$CLI snapshot` writes the full a11y YAML to `.playwright-cli/page-<timestamp>.yml`. Do NOT read the whole file.

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
2. If that file is missing or genuinely stale, call `$CLI snapshot` and `Read` a targeted slice
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
````

- [ ] **Step 2: Update references**

```bash
# Update scenario-outline.md
sed -i '' 's/mcp-snapshot-rules\.md/cli-snapshot-rules.md/g' .claude/skills/bdd-step-implementor/references/scenario-outline.md

# Verify SKILL.md already updated in Task 7
grep -n 'mcp-snapshot-rules' .claude/skills/bdd-step-implementor/SKILL.md
```
Expected: no matches in SKILL.md.

- [ ] **Step 3: Delete the old file**

```bash
git rm .claude/skills/bdd-step-implementor/references/mcp-snapshot-rules.md
```

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/bdd-step-implementor/references/cli-snapshot-rules.md \
        .claude/skills/bdd-step-implementor/references/scenario-outline.md
git commit -m "docs(references): rename mcp-snapshot-rules -> cli-snapshot-rules"
```

---

### Task 10: Rewrite `references/prerequisites.md`

**Files:**
- Modify: `.claude/skills/bdd-step-implementor/references/prerequisites.md`

- [ ] **Step 1: Delete Section 3 (MCP Configuration)**

Delete the entire "### ✅ 3. MCP Configuration (.mcp.json)" section (lines 139-309). Replace with:

````markdown
### ✅ 3. playwright-cli Installation

**Required:**
- ✓ `playwright-cli` available on PATH
- ✓ Version >= 0.1.8

**Verification:**
```bash
playwright-cli --version  # Expected: 0.1.8 or higher
```

**Install / upgrade:**
```bash
npm install -g @playwright/cli@latest
```

**Why it matters:**
- The skill's Phase 3 observation uses `playwright-cli attach --cdp=ws://...` to connect to the Cucumber-launched browser. Without the CLI (or with a pre-0.1.8 version that lacks a standalone `attach` command), Phase 3 cannot run.
- CLI 0.1.8 exposes `attach`, `snapshot`, `eval`, `tab-list`, `screenshot` — the exact observation surface the skill needs.

**Related doctor.js checks:**
- `playwright-cli`
````

- [ ] **Step 2: Update LLM Verification Check 2 (around line 681)**

Replace "Check 2: MCP Config Semantic Verification" content with:

````markdown
### Check 2: playwright-cli Install Verification

**Goal:** Verify `playwright-cli` is installed at a compatible version.

**Steps:**
1. Run `playwright-cli --version`.
2. ✅ Verify version is >= 0.1.8.
3. ✅ If < 0.1.8, run `npm install -g @playwright/cli@latest` (or `sudo npm install -g @playwright/cli@latest` on systems with restricted `/usr/local`).

**Report format:**
```
✅ playwright-cli Verification: PASS
   - Installed: ✅ (version 0.1.8)
   - Version >= 0.1.8: ✅
```
````

- [ ] **Step 3: Remove any remaining `.mcp.json` references**

```bash
grep -n "\.mcp\.json\|mcp-config\|playwright-cdp\|run-mcp-server\|--caps=testing" .claude/skills/bdd-step-implementor/references/prerequisites.md
```
Remove any surviving mentions unless they are in the Troubleshooting Guide's historical context (better to delete those too).

- [ ] **Step 4: Commit**

```bash
git add .claude/skills/bdd-step-implementor/references/prerequisites.md
git commit -m "docs(prerequisites): replace MCP config section with playwright-cli install check"
```

---

### Task 11: Update project-level `.mcp.json` and `project-profile.json`

**Files:**
- Modify: `/Users/dengzicheng/repository/claude_playwright/.mcp.json`
- Modify: `/Users/dengzicheng/repository/claude_playwright/.claude/project-profile.json`

This task affects **this** repo as the test bed. In downstream user projects, the same manual change is expected; setup.js changes in Task 4 already prevent automatic regression.

- [ ] **Step 1: Edit `.mcp.json`**

Remove the `playwright-cdp` entry. Keep `playwright-test`. Final content:

```json
{
  "mcpServers": {
    "playwright-test": {
      "command": "npx",
      "args": [
        "playwright",
        "run-test-mcp-server"
      ]
    }
  }
}
```

- [ ] **Step 2: Sanity-check `.claude/project-profile.json`**

`cdp_port: 9222` stays. No changes expected unless you want to add an explicit `cli_session_prefix` field. Optional — skip unless it turns out to be useful during Task 12 end-to-end validation.

- [ ] **Step 3: Commit**

```bash
git add .mcp.json .claude/project-profile.json
git commit -m "chore: remove playwright-cdp MCP from project .mcp.json"
```

---

### Task 12: End-to-end validation against a real BDD scenario

**Files:**
- No code changes; this is the acceptance test.

- [ ] **Step 1: Identify a representative feature file**

```bash
ls /Users/dengzicheng/repository/claude_playwright/src/features/**/*.feature 2>/dev/null | head -3
```

If there is no suitable feature in this repo, dry-run against the `test-plan-edge-cases.md` examples in `evals/` by constructing a small synthetic feature — a 3-step scenario against https://demo.playwright.dev/todomvc is sufficient.

- [ ] **Step 2: Run the skill end-to-end in a fresh Claude Code session**

The author runs Claude Code, opens this repo, and says:
> "Implement the steps for features/<your-feature>.feature using the bdd-step-implementor skill."

Observe:
1. Phase 3B: the agent runs `playwright-cli attach --cdp="$(cat .../cdp-ws.txt)"` successfully
2. Phase 3C: `playwright-cli snapshot` returns a file path; the agent uses `Read` with `offset`/`limit` to fetch only relevant portions
3. No `mcp__playwright-cdp__*` tool invocations
4. Final `impl.js` files validate; `run_command` passes
5. Quality gate passes

- [ ] **Step 3: Measure token usage**

After the run, compare `conversation.json` or CLI `usage` output against a pre-migration run (if available). Record the savings.

- [ ] **Step 4: If validation passes, commit observations**

```bash
echo "See MIGRATION_PLAN.md Task 12 for end-to-end validation notes." \
  > .claude/skills/bdd-step-implementor/MIGRATION_VALIDATION.md
# Append actual observations (step counts, token deltas, any surprises) to that file.
git add .claude/skills/bdd-step-implementor/MIGRATION_VALIDATION.md
git commit -m "docs: record end-to-end validation of playwright-cli migration"
```

- [ ] **Step 5: If validation fails, document and iterate**

Fail modes and where to look first:
- `playwright-cli attach` fails → check `cdp-ws.txt` contents, network to the port, that the ws URL is still valid (Chrome restart invalidates it)
- `$CLI snapshot` hangs → attached daemon lost connection; run `$CLI close-all` and re-attach
- Identity check fails (wrong tab) → snapshot reveals the browser is showing a different page; check that the same session name is used everywhere in that shell
- `tsc` compilation of stubs unexpectedly fails → not caused by migration; check profile's `tsc_check` path

---

### Task 13: Merge and publish

- [ ] **Step 1: Rebase and self-review**

```bash
git log --oneline migration/mcp-to-playwright-cli ^main
```
Expect ~12 commits (Tasks 1-12). If any looks wrong, fix forward rather than amending.

- [ ] **Step 2: Open PR**

```bash
gh pr create --title "bdd-step-implementor: migrate from playwright-cdp MCP to playwright-cli" \
  --body "$(cat <<'EOF'
## Summary
- Replace `playwright-cdp` MCP with `playwright-cli attach` (v0.1.8+) for Phase 3 observation
- Save 70%+ of per-run observation tokens by writing snapshots to files and reading targeted slices on demand
- `start-run.js` now resolves the CDP ws URL and persists it; all `playwright-cli` invocations read from `mcp-bridge/<runId>/cdp-ws.txt`
- doctor/setup swap: remove `.mcp.json` MCP patching, add `playwright-cli >= 0.1.8` check
- Keep `playwright-test` MCP for other skills; only `playwright-cdp` is removed

## Test plan
- [ ] `npx jest .claude/skills/bdd-step-implementor/scripts/__tests__/` passes
- [ ] `node .claude/skills/bdd-step-implementor/scripts/doctor.js` reports READY
- [ ] End-to-end run of a representative feature file with Phase 3 observation via `playwright-cli` (see MIGRATION_VALIDATION.md)
- [ ] Grep shows no surviving `mcp__playwright-cdp__` references in SKILL.md and references/

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Wait for approval and merge**

---

## Self-Review

I cross-checked this plan against the migration surface table and the validated findings. Three things to flag before execution:

1. **`start-run.js` structure** — Task 2 Step 5/6 assumes the file has an async main flow and a `port`/`launchPid`/`runDir` variable. Before writing the patch, open the file and map those names; if the structure differs, adapt the Step 5/6 code. The test in Step 1 is independent of this structural shape, so it stays.

2. **Test runner decision:** use `node --test` (Node 18+ built-in, zero new dependencies).

3. **LLM-facing prompts in `evals/test-plan-edge-cases.md`** — I did not enumerate this file's content. Before merging, grep it for `mcp__playwright-cdp` / `browser_snapshot` and update any surviving prompts. Add as Task 11.5 if needed.

Placeholder scan: none found.

Type consistency: the CLI session name `bdd-<runId>` is used consistently in Task 3 (stop-run), Task 7 (SKILL.md Phase 3B), and Task 12 (validation). The file `mcp-bridge/<runId>/cdp-ws.txt` is referenced identically across Task 2, Task 7, and Task 12.

---

## Execution Handoff

**Plan complete and saved to `.claude/skills/bdd-step-implementor/MIGRATION_PLAN.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best when you want clean separation between planning (done) and execution, and you're OK with me coordinating.

**2. Inline Execution** — We execute tasks in this session using executing-plans, batch execution with checkpoints for review. Best when you want to steer each task and see trade-offs in real time.

**Which approach?**
