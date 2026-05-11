# Configuration Checklist Guide

Complete setup and verification guide for the BDD Step Implementor skill.

## Table of Contents

**[Quick Start](#quick-start)**

**Machine Checks (doctor.js verifies these):**
1. [Node.js & npm Toolchain](#-1-nodejs--npm-toolchain)
2. [Project Dependencies](#-2-project-dependencies)
3. [playwright-cli Installation](#-3-playwright-cli-installation)
4. [Cucumber Hooks Configuration](#-4-cucumber-hooks-configuration)
5. [Platform Tooling](#-5-platform-tooling)
6. [Project Profile Configuration](#-6-project-profile-configuration)

**[LLM Verification Checklist](#llm-verification-checklist)** ← Execute after doctor.js reports READY

**[Troubleshooting Guide](#troubleshooting-guide)**

---

## Quick Start

**For first-time setup in a new project:**

```bash
# 1. Resolve skill path
SKILL_DIR=$(node ~/.claude/skills/bdd-step-implementor/scripts/resolve-skill-path.js 2>/dev/null || node .claude/skills/bdd-step-implementor/scripts/resolve-skill-path.js)

# 2. Discover project structure AND run configuration checks automatically
node "$SKILL_DIR/scripts/discover-project.js" --run-doctor

# 3. Fix issues (if doctor reports auto-fixable issues)
node "$SKILL_DIR/scripts/setup.js"
node "$SKILL_DIR/scripts/doctor.js"  # Verify READY status
```

**Alternative (manual steps):**
```bash
# 2a. Discover project structure only
node "$SKILL_DIR/scripts/discover-project.js"

# 2b. Run configuration checks manually
node "$SKILL_DIR/scripts/doctor.js"

# Then continue with step 3 above...
```

**After doctor.js reports `READY`, proceed to the [LLM Verification Checklist](#llm-verification-checklist) for semantic validation.**

---

## Configuration Requirements Checklist

**Note:** This section documents the **machine-verifiable checks** that `doctor.js` performs. After `doctor.js` reports `READY`, you must still complete the [LLM Verification Checklist](#llm-verification-checklist) for semantic validation that requires human/LLM judgment.

### ✅ 1. Node.js & npm Toolchain

**Required:**
- ✓ Platform: macOS (darwin), Linux, or Windows (win32)
- ✓ Node.js version >= 18
- ✓ npm available on PATH
- ✓ npx available on PATH

**Verification:**
```bash
# Platform check (should be darwin, linux, or win32)
node -p "process.platform"

# Node version (must be v18.x or higher)
node --version

# npm & npx availability
npm --version
npx --version
```

**Why it matters:**
- Platform: Uses platform-specific commands (lsof on Unix, netstat/taskkill on Windows)
- Node.js >= 18: Required by Playwright and modern Node.js APIs
- npm: Required to install dependencies (@playwright/test, @cucumber/cucumber)
- npx: All Cucumber and Playwright CLI commands use npx

**Common issues:**
- ❌ Node < 18 → npm install fails → workflow cannot start
- ❌ npx missing → cannot run cucumber-js or playwright → entire workflow breaks

**Related doctor.js checks:**
- `platform-supported`, `node-version`, `npm-exists`, `npx-exists`

---

### ✅ 2. Project Dependencies

**Required:**
- ✓ package.json exists at project root
- ✓ @playwright/test >= 1.57.0 installed
- ✓ @cucumber/cucumber installed

**Verification:**
```bash
# Check package.json exists
ls package.json

# Check dependencies installed
ls node_modules/@playwright/test/package.json
ls node_modules/@cucumber/cucumber/package.json

# Check Playwright version
npx playwright --version  # Should be >= 1.57.0
```

**Auto-fix:**
```bash
# If dependencies missing, setup.js runs:
npm install
```

**Why it matters:**
- package.json: Ensures valid Node.js project root
- @playwright/test >= 1.57.0: Required by Playwright CLI and for browser automation
- @cucumber/cucumber: Provides Given/When/Then step registration and test runner

**Common issues:**
- ❌ @playwright/test missing → TypeScript compilation fails → tests fail immediately
- ❌ @playwright/test < 1.57.0 → Missing Playwright features → Cannot run automation

**Related doctor.js checks:**
- `package-json`, `deps-playwright-test`, `deps-cucumber`, `playwright-cli`

---

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

---

### ✅ 4. Cucumber Hooks Configuration

**Required:**
- ✓ hooks file exists at standard location or path in project-profile.json
- ✓ BeforeAll hook launches Chromium with --remote-debugging-port
- ✓ CDP port uses PW_MCP_CDP_PORT env var
- ✓ CDP configuration is unconditional (not wrapped in if (!CI))
- ✓ AfterAll hook closes browser with await browser.close()
- ✓ Page access matches project-profile.json → page_access.pattern

**Standard hooks locations:**
- `src/support/hooks.ts` (Cucumber convention)
- `src/step-definitions/hooks/hooks.ts`
- `src/steps/hooks/hooks.ts`
- Custom path in project-profile.json → files.hooks

**Required BeforeAll pattern:**
```typescript
import { BeforeAll, AfterAll } from '@cucumber/cucumber';
import { chromium, Browser } from '@playwright/test';

let browser: Browser;

BeforeAll(async function () {
  const cdpPort = process.env.PW_MCP_CDP_PORT || '9222';  // Fallback optional
  browser = await chromium.launch({
    headless: false,
    args: [`--remote-debugging-port=${cdpPort}`]
  });
  // ... set up World.page or BasePage.basePage
});
```

**Required AfterAll pattern:**
```typescript
AfterAll(async function () {
  await browser.close();
});
```

**Verification (machine - doctor.js checks):**
```bash
# 1. Find hooks file
HOOKS_PATH=$(cat .claude/project-profile.json | grep -o '"hooks": "[^"]*"' | cut -d'"' -f4)
if [ -z "$HOOKS_PATH" ]; then
  # Fallback search
  for path in "src/support/hooks.ts" "src/step-definitions/hooks/hooks.ts" "src/steps/hooks/hooks.ts"; do
    if [ -f "$path" ]; then
      HOOKS_PATH=$path
      break
    fi
  done
fi

# 2. Check file exists
ls $HOOKS_PATH

# 3. Check contains PW_MCP_CDP_PORT (string match only)
grep -q "PW_MCP_CDP_PORT" $HOOKS_PATH

# 4. Check contains AfterAll + browser.close()
grep -q "AfterAll" $HOOKS_PATH && grep -q "browser.close()" $HOOKS_PATH
```

**Verification (LLM - semantic checks):**

1. **Read hooks file in full:**
```bash
cat {hooks_path}
```

2. **Verify CDP port is in BeforeAll scope:**

✅ **Correct:**
```typescript
BeforeAll(async function () {
  const port = process.env.PW_MCP_CDP_PORT || '9222';
  browser = await chromium.launch({
    args: [`--remote-debugging-port=${port}`]
  });
});
```

❌ **Wrong - in Before (runs per scenario, not once):**
```typescript
Before(async function () {
  const port = process.env.PW_MCP_CDP_PORT || '9222';
  browser = await chromium.launch({
    args: [`--remote-debugging-port=${port}`]
  });
});
```

3. **Verify CDP port is NOT conditionally disabled:**

❌ **Wrong - disabled in CI:**
```typescript
BeforeAll(async function () {
  const launchOptions = process.env.CI
    ? { headless: true }
    : { headless: false, args: ['--remote-debugging-port=9222'] };
  browser = await chromium.launch(launchOptions);
});
// CDP only enabled in local dev, not in CI
```

❌ **Wrong - only in debug mode:**
```typescript
const cdpArgs = process.env.DEBUG
  ? [`--remote-debugging-port=${port}`]
  : [];
browser = await chromium.launch({ args: cdpArgs });
```

✅ **Correct - CDP always enabled when env var is set:**
```typescript
const cdpPort = process.env.PW_MCP_CDP_PORT;
const cdpArgs = cdpPort ? [`--remote-debugging-port=${cdpPort}`] : [];
browser = await chromium.launch({
  args: [...otherArgs, ...cdpArgs]
});
```

**Note:** It's OK to only add CDP args when PW_MCP_CDP_PORT is set (as in the correct example). The key is: when the env var IS set, it must be used unconditionally - not wrapped in additional `if (!CI)` or `if (DEBUG)` checks.

4. **Verify browser.close() is in AfterAll:**

✅ **Correct:**
```typescript
AfterAll(async function () {
  await browser.close();
});
```

❌ **Wrong - in After (runs per scenario):**
```typescript
After(async function () {
  await browser.close();
});
// Browser closes after EACH scenario, not at the end
```

⚠️ **Acceptable but not ideal - conditional close:**
```typescript
AfterAll(async function () {
  if (browser) await browser.close();
});
// Works, but the check is unnecessary if browser is always created in BeforeAll
```

5. **Verify Page object is exposed correctly:**

Read project-profile.json → page_access.pattern and verify hooks code matches:

- Pattern: `world_property` → hooks should do: `this.page = await context.newPage()`
- Pattern: `page_manager` → hooks should do: `this.pages = new PageManager(page)`
- Pattern: `static_singleton` → hooks should do: `BasePage.basePage = await context.newPage()`

**Note:** If the pattern in project-profile.json doesn't match the actual hooks implementation, this is a profile generation issue (run `discover-project.js --force` to fix). This check is informational - it helps identify configuration drift.

**Edge cases:**

- **Hooks in custom path:** Some projects use non-standard layouts (e.g., `tests/support/setup.ts`). discover-project.js should detect this and save to profile.files.hooks. If doctor.js fails to find hooks, check if the file exists but in a non-standard location, then update the profile manually or re-run discovery.

- **CDP port with no fallback:** If hooks only has `const port = process.env.PW_MCP_CDP_PORT;` without `|| '9222'`, that's acceptable as long as start-run.js always sets the env var. However, adding a fallback matching the configured port (from project-profile.json) makes the setup more robust in case the env var isn't set.

- **Multiple browsers:** Some projects launch multiple browsers (Firefox + Chromium, or multiple Chromium instances). Ensure:
  - At least one Chromium instance has the CDP port
  - The browser variable closed in AfterAll is the one with CDP (or close all browsers)

**Example:**
```typescript
let chromiumBrowser: Browser;
let firefoxBrowser: Browser;

BeforeAll(async function () {
  const port = process.env.PW_MCP_CDP_PORT || '9222';
  chromiumBrowser = await chromium.launch({
    args: [`--remote-debugging-port=${port}`]
  });
  firefoxBrowser = await firefox.launch();
});

AfterAll(async function () {
  await chromiumBrowser.close();  // ✅ Close the one with CDP
  await firefoxBrowser.close();
});
```

- **BeforeAll cleanup of previous browser:** Some projects check and close any existing browser before launching a new one:
```typescript
BeforeAll(async function () {
  if (browser) {
    await browser.close();  // Clean up previous run
  }
  const port = process.env.PW_MCP_CDP_PORT || '9222';
  browser = await chromium.launch({
    args: [`--remote-debugging-port=${port}`]
  });
});
```
This is good practice and doesn't affect CDP functionality.

**Why it matters:**
- **hooks file:** Cucumber hooks control browser lifecycle (when to launch, when to close). Without hooks, no browser is launched and tests cannot run.
- **CDP port in BeforeAll:** The browser must expose a remote debugging port for MCP to attach. BeforeAll runs once before all scenarios, ensuring the browser stays alive for the entire test suite.
- **PW_MCP_CDP_PORT env var:** start-run.js sets this variable dynamically. hooks must read it to enable/disable CDP mode without code changes.
- **Unconditional CDP:** If wrapped in `if (!process.env.CI)`, CDP will be disabled in CI environments, breaking the attach workflow in CI.
- **browser.close() in AfterAll:** Ensures the test process exits cleanly after all scenarios complete. AfterAll only runs after all scenarios finish, so the browser stays open while stubs are paused (correct behavior).

**Impact if fails:**
- ❌ No hooks file → No browser launched → Tests fail immediately with "page is not defined" (Phase 1 dry-run).
- ❌ CDP port not in BeforeAll → If in Before instead, browser is recreated per scenario, causing port conflicts and unreliable CDP connections.
- ❌ CDP port conditionally disabled (e.g., `if (!CI)`) → Works locally but fails in CI → Attach workflow breaks in CI environment (Phase 3B).
- ❌ CDP port not using PW_MCP_CDP_PORT → Hardcoded port may conflict with start-run.js expectations → Port mismatch errors (Phase 3B).
- ❌ No browser.close() in AfterAll → Test process hangs after completion → Orphan browser processes accumulate.
- ❌ browser.close() in After → Browser closes after first scenario → Subsequent scenarios fail with "browser closed" errors.
- ❌ Page access pattern mismatch → impl.js uses wrong pattern (e.g., this.page when project uses BasePage.basePage) → "page is not defined" or "this.page is undefined" errors (Phase 3D impl execution fails).

**Related doctor.js checks:**
- `hooks-exists`, `hooks-cdp-port`, `hooks-close-browser`

---

### ✅ 5. Platform Tooling

**Required:**

**macOS/Linux:**
- ✓ lsof command available

**Windows:**
- ✓ netstat command available
- ✓ taskkill command available

**Verification:**
```bash
# macOS/Linux
lsof -v  # Should show version info

# Windows
netstat -ano  # Should show active connections
taskkill /?   # Should show help text
```

**Why it matters:**
start-run.js uses these tools for CDP port cleanup:
1. Detect processes holding CDP port: `lsof -i :9222` (macOS) or `netstat -ano | findstr :9222` (Windows)
2. Terminate orphan processes: `kill -9 <pid>` (macOS) or `taskkill /F /PID <pid>` (Windows)

Without these tools, --clean-port flag cannot work, causing "address already in use" errors.

**Common issues:**
- ❌ Git Bash on Windows → taskkill may not be in PATH (use CMD instead)
- ❌ Corporate Windows policies → taskkill may be restricted (ask IT for exception)

**Related doctor.js checks:**
- `platform-tooling`

---

### ✅ 6. Project Profile Configuration

**Location:** `.claude/project-profile.json`

**Generated by:** `node "$SKILL_DIR/scripts/discover-project.js"`

**Key fields and their impact:**

| Field | Purpose | Used in Phase | Impact if wrong |
|-------|---------|---------------|-----------------|
| `commands.profile_flag` | Cucumber profile flag (e.g., --profile=uat) | 1, 3, 4 | Tests use wrong environment/config |
| `commands.dry_run` | Template for dry-run command | 1 | Cannot detect undefined steps |
| `commands.run` | Template for running isolated scenario | 1, 4 | Cannot run final validation |
| `commands.attach_plain` | Template for plain Scenario attach | 1 | Attach fails |
| `commands.attach_outline` | Template for Scenario Outline attach | 1 | Attach fails |
| `commands.tsc_check` | TypeScript type-check command | 2 | Cannot verify stub compiles |
| `files.hooks` | Path to hooks file | 0, LLM | Reads wrong file for CDP verification |
| `files.world` | Path to World file | 0 | Cannot learn World properties |
| `files.stub_step_def` | Path for temporary stub file | 2, 4 | Stub written to wrong location |
| `world.type` | TypeScript type name for World | 2 | Stub generates wrong type → compile error |
| `world.import_from_stub` | Relative import path from stub to World | 2 | Stub cannot import World → compile error |
| `page_access.pattern` | How Page object is accessed | 3D | impl.js uses wrong pattern → runtime error |
| `directories.page_object_glob` | Glob pattern to find Page Objects | 1 | Cannot find PO files → planning fails |
| `cdp_port` | CDP port number | 3 | Port mismatch → MCP cannot connect |

**Critical consistency requirements:**

**1. World Import Path Consistency:**
- `files.stub_step_def` (where stub is written)
- `files.world` (where World class lives)
- `world.import_from_stub` (relative path from stub to World)

**2. CDP Port Two-Way Consistency:**
- `project-profile.json` → cdp_port
- `hooks.ts` → PW_MCP_CDP_PORT fallback (if exists)

**3. Page Access Pattern Consistency:**
- `project-profile.json` → page_access.pattern (detected pattern)
- `hooks.ts` implementation (actual code)

**Possible patterns:**
- `"world_property"` → hooks does: `this.page = await context.newPage()`
- `"page_manager"` → hooks does: `this.pages = new PageManager(page)`
- `"static_singleton"` → hooks does: `BasePage.basePage = await context.newPage()`

**4. Command Template Placeholders:**

| Template | Required Placeholders | Example |
|----------|----------------------|---------|
| dry_run | {feature_path} | `npm run uat -- src/features/login.feature --dry-run` |
| run | {tag_filter} | `npm run uat -- --tags "@my_tag and @UAT"` |
| attach_plain | {tag_filter} | `npm run uat -- --tags "@my_tag and @UAT"` |
| attach_outline | {feature_path}, {line}, {tag_filter} | `npm run uat -- src/features/login.feature:25 --tags "@my_tag"` |

**When to regenerate:**
```bash
# Run with --force when:
# - Project structure changed (moved directories, renamed files)
# - Cucumber config changed (added/removed profiles)
# - World implementation changed (switched from this.page to BasePage.basePage)
# - npm scripts changed (renamed test commands)
# - Page access pattern mismatch detected

node "$SKILL_DIR/scripts/discover-project.js" --force
```

**Warning:** --force overwrites all auto-discovered fields. Back up manual edits first.

---

## LLM Verification Checklist

**⚠️ IMPORTANT: Execute this checklist AFTER the following steps:**

1. ✅ Run `discover-project.js` to generate `.claude/project-profile.json`
2. ✅ Run `doctor.js` which reports `READY` status
3. ✅ Run `setup.js` (if doctor found auto-fixable issues)

**Purpose:** Perform semantic verification to catch edge cases that require human/LLM judgment. While `doctor.js` validates machine-checkable requirements (file existence, string patterns), this checklist verifies **semantic correctness** — ensuring configurations actually match project behavior.

### Check 1: Hooks Semantic Verification

**Goal:** Verify hooks.ts correctly implements CDP port and browser lifecycle

**Steps:**
1. Locate and read hooks file:
   ```bash
   HOOKS_PATH=$(cat .claude/project-profile.json | grep '"hooks"' | cut -d'"' -f4)
   cat $HOOKS_PATH
   ```

2. ✅ Verify CDP port in BeforeAll (not Before)
3. ✅ Verify CDP NOT conditionally disabled (no if (!CI) wrapping CDP args)
4. ✅ Verify browser.close() in AfterAll (not After)
5. ✅ Verify CDP port fallback matches cdp_port in configs (if fallback exists)

**Report format:**
```
✅ Hooks Semantic Check: PASS
   - CDP port in BeforeAll: ✅
   - CDP not conditionally disabled: ✅
   - browser.close() in AfterAll: ✅
   - Port fallback consistency: ✅ (all use 9222)
```

---

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

---

### Check 3: Project Profile Consistency

**Goal:** Verify project-profile.json matches actual project files

**Steps:**
1. ✅ Verify hooks path exists and is readable
2. ✅ Verify world path exists and exports World class
3. ✅ Verify page_access.pattern matches hooks implementation
4. ✅ Verify cdp_port two-way consistency

**Report format:**
```
✅ Project Profile Consistency: PASS
   - Hooks path valid: ✅ (src/step-definitions/hooks/hooks.ts)
   - World path valid: ✅ (src/setup/world.ts)
   - Page access pattern matches: ✅ (static_singleton)
   - CDP port two-way match: ✅ (all 9222)
```

---

### Check 4: Edge Case Scan

**Goal:** Detect environment-specific issues

**Checks:**
1. ✅ Custom CDP port: Verify all two locations use same port
2. ✅ Multiple browsers: Verify Chromium has CDP, AfterAll closes correct browser
3. ✅ CI conditionals: Verify process.env.CI doesn't disable CDP

**Report format:**
```
✅ Edge Case Scan: PASS
   - Custom CDP port: N/A (using default 9222)
   - Multiple browsers: N/A (single Chromium)
   - CI conditionals: ✅ (only affects headless, not CDP)
```

---

### Check 5: Command Template Validation

**Goal:** Verify command templates have required placeholders

**Steps:**
1. ✅ attach_outline has {feature_path}, {line}, {tag_filter}
2. ✅ dry_run has {feature_path}
3. ✅ run has {tag_filter}
4. ✅ attach_plain has {tag_filter}

**Report format:**
```
✅ Command Template Validation: PASS
   - attach_outline has all 3 placeholders: ✅
   - dry_run has feature_path: ✅
   - run has tag_filter: ✅
   - attach_plain has tag_filter: ✅
```

---

### Final Verification Summary

**All checks passed:**
```
=== LLM Verification Results ===

✅ Check 1: Hooks Semantic - PASS
✅ Check 2: MCP Config Semantic - PASS
✅ Check 3: Project Profile Consistency - PASS
✅ Check 4: Edge Case Scan - PASS
✅ Check 5: Command Template Validation - PASS

Status: READY for implementation
```

**Issues found:**
```
=== LLM Verification Results ===

✅ Check 1: Hooks Semantic - PASS
✅ Check 2: MCP Config Semantic - PASS
❌ Check 3: Project Profile Consistency - FAIL (1 issue)
✅ Check 4: Edge Case Scan - PASS
✅ Check 5: Command Template Validation - PASS

Issues found: 1
- Page access pattern mismatch (profile: world_property, actual: static_singleton)

Recommended actions:
1. Run: node .claude/skills/mcp-step-implementor/scripts/discover-project.js --force

Status: NOT READY (fix issues before implementation)
```

---

## Troubleshooting Guide

### `manual-required` issues
Must be resolved manually before workflow can run. Check doctor.js output for specific instructions.

### `unsupported` issues
Indicate project structure incompatibility. Check skill documentation or contact support.

### Environment changes
If you change Node versions, delete node_modules, or modify Cucumber config, re-verify:
```bash
node "$SKILL_DIR/scripts/doctor.js"
node "$SKILL_DIR/scripts/setup.js"  # If issues found
```

### Common issues and fixes

**"address already in use" (port 9222)**
```bash
# Run with --clean-port flag
node "$SKILL_DIR/scripts/start-run.js" --clean-port
```

**"playwright-cli connection refused"**
- Check CDP port consistency (project-profile.json, hooks.ts)
- Verify browser launched with --remote-debugging-port
- Verify playwright-cli is installed and version >= 0.1.8

**"page is not defined" errors**
- Verify page_access.pattern matches hooks implementation
- Run discover-project.js --force to regenerate profile

---

## Quick Verification

**After setup, verify these files exist:**
```bash
ls .claude/project-profile.json  # ✅ Should exist
```

**Run doctor and verify READY status:**
```bash
node "$SKILL_DIR/scripts/doctor.js"
# Should output: "READY"
```

**If READY and files exist:** Environment is ready for implementation workflows.
