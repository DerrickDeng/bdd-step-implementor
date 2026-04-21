# wait-for-step.js Error Handling

This reference provides detailed diagnostics and recovery steps for each `wait-for-step.js` exit code.

**Quick reference:**
- **Exit 0**: Success - continue to next phase
- **Exit 2**: Timeout - process was alive, needs investigation (see below)
- **Exit 3**: Process died - confirmed crash, read log and restart
- **Exit 4**: Run deadline expired - whole run budget exhausted

---

## Exit 0: Success

Step pause JSON was found (or step already passed from a restored impl).

**Action:** Continue to Phase 3B (Attach MCP to the live browser).

---

## Exit 3: test_process_exited

**What happened:**
The test process was confirmed dead. `wait-for-step.js` checks process liveness every 500ms during the wait, and the process failed this check.

**Why trust this:**
This is not a timeout - it's a confirmed process death detected during active monitoring. The diagnosis is reliable.

**Actions:**

1. **Inspect the canonical launcher manifest first:**
   - `mcp-bridge/<runId>/launch.json` is the source of truth for PID, timeout, and log metadata.

2. **Read the log file for crash details:**
   ```bash
   tail -100 test-results/mcp-step.log
   ```

3. **If the log is empty, inspect the launcher failure snapshot:**
   - Check `mcp-bridge/<runId>/launch-failure.json`
   - This file is written when the detached child exits before the first pause and the main log is still empty or incomplete

4. **Diagnose the error type:**
   - **Missing dependency or configuration error**: Module not found, invalid config file
   - **Step implementation crash**: Syntax error in impl.js, unhandled exception, null pointer
   - **Test framework error**: Hooks failure, invalid feature file syntax, Cucumber setup issue
   - **Browser crash**: CDP connection lost, browser process killed

5. **Fix the issue:**
   - Install missing dependencies
   - Fix syntax errors in impl.js
   - Correct configuration values
   - Fix hook implementation

6. **Restart the run:**
   ```bash
   node "$SKILL_DIR/scripts/stop-run.js" --clean-port
   node "$SKILL_DIR/scripts/start-run.js" --port 9222 --log test-results/mcp-step.log --step-count <N> --clean-port -- <attach_command>
   ```

**Do NOT:**
- Retry wait-for-step without fixing the issue
- Assume the process might still be alive
- Skip reading the log

---

## Exit 2: wait_for_step_timeout

**What happened:**
The waiter timed out after 120 seconds (or the specified timeout), but the process was alive during the entire wait period.

**Why this needs investigation:**
Although the process was alive during the wait, it may have died immediately after the timeout (race condition). Or it may still be alive but stuck or slow. We need to determine which scenario applies.

### Step 1: Double-check process liveness

**Why:** Handle the race condition where the process dies right after `wait-for-step.js` exits.

**How to check:**

1. **Resolve the active run and read the PID from the launcher manifest:**
   ```bash
   node -e "const fs=require('fs'); const path=require('path'); const latest=JSON.parse(fs.readFileSync('mcp-bridge/latest-run.json','utf8')); const launch=JSON.parse(fs.readFileSync(path.join('mcp-bridge', latest.runId, 'launch.json'),'utf8')); console.log(launch.pid)"
   ```
   This will output a PID, for example: `20892`

2. **Check if that PID is still alive:**

   **On Windows:**
   ```bash
   tasklist /FI "PID eq 20892" /NH 2>&1 | head -3
   ```
   - If you see a line with the PID and process name → **alive**
   - If you see "INFO: No tasks are running" → **dead**

   **On Unix/Mac:**
   ```bash
   ps -p 20892 -o pid=,command= 2>/dev/null || echo "Process not found"
   ```
   - If you see the PID and command → **alive**
   - If you see "Process not found" → **dead**

### Step 2a: If process is now DEAD

The process died right after the timeout (race condition).

**Actions:**
1. Read the log to diagnose the crash:
   ```bash
   tail -100 test-results/mcp-step.log
   ```
2. If the log is empty, inspect `mcp-bridge/<runId>/launch-failure.json`
3. Diagnose and fix the issue (same as Exit 3)
4. Restart the run
5. **Do NOT retry wait** - would waste another 120s waiting for a dead process

### Step 2b: If process is still ALIVE

The process is running but the step hasn't appeared yet. Analyze WHY.

**Read the progress object from the error JSON:**
The `wait-for-step.js` error output includes a `progress` object:
```json
{
  "error": "wait_for_step_timeout",
  "progress": {
    "highestPassedStep": null,
    "currentPausedStep": null,
    "waitingForImplStep": null,
    "observedSteps": []
  }
}
```

Use this to determine the specific cause:

---

#### Case A: No bridge files yet (`observedSteps.length === 0`)

**Diagnosis:**
The test is stuck in setup or earlier implemented steps (login, navigation, Before hooks, etc.). No stub steps have been reached yet.

**Why this happens:**
- Earlier implemented steps (steps 1-3 that don't need impl.js) are taking longer than expected
- Before hooks are slow (database setup, API warm-up)
- Login/navigation steps are slow
- Network latency or slow page load

**What to do:**

1. **Check log for current activity:**
   ```bash
   tail -50 test-results/mcp-step.log
   ```
   Look for:
   - What step is currently executing
   - Any error messages (even if test hasn't crashed)
   - Long-running operations

2. **If no obvious error:**
   - The earlier steps are just slow
   - Retry wait-for-step with same or extended timeout:
     ```bash
     node "$SKILL_DIR/scripts/wait-for-step.js" N --timeout-ms 180000
     ```
   - Or wait for the earlier steps to complete and the test will eventually reach step N

3. **If there's an error in the log:**
   - Fix the error in the earlier step implementation
   - Restart the run

**Example scenario:**
- Requested step: 4 (first stub step)
- Progress: `observedSteps.length === 0`
- Log shows: "Step 3: agent long execution" (a 180s wait)
- **Action**: Retry wait with extended timeout, or wait for step 3 to finish

---

#### Case B: Paused on earlier step (`currentPausedStep < requestedStepIndex`)

**Diagnosis:**
The test has reached a stub step, but it's step X (where X < N), not step N. Step X is paused waiting for `impl.js`.

**Why this happens:**
- You requested step N, but step X hasn't been implemented yet
- The test paused on step X first

**What to do:**

1. **Note the paused step number:**
   From the progress object: `"currentPausedStep": 3`

2. **Go implement step X first:**
   - Go back to Phase 3 and implement step `currentPausedStep`
   - Don't wait for step N yet

3. **After implementing step X:**
   - The stub will execute step X
   - Test will progress to later steps
   - Eventually step N will pause

**Example scenario:**
- Requested step: 5
- Progress: `currentPausedStep: 3`
- **Action**: Go back and implement step 3 first. Don't wait for step 5.

---

#### Case C: Test progressing but slow (steps passed but not reached N yet)

**Diagnosis:**
Some steps have passed (`highestPassedStep >= 0`), but the test hasn't reached step N yet. It's making progress, just slower than expected.

**Why this happens:**
- Steps are passing but taking time to execute
- Page navigation between steps is slow
- Network requests or animations are slow

**What to do:**

1. **Check progress:**
   ```json
   "highestPassedStep": 2
   ```
   The test has passed step 2, working on step 3, but you requested step 5.

2. **Retry wait with fresh timeout:**
   ```bash
   node "$SKILL_DIR/scripts/wait-for-step.js" N --timeout-ms 120000
   ```

3. **If this keeps happening (repeated timeouts):**
   - Consider extending the timeout:
     ```bash
     node "$SKILL_DIR/scripts/wait-for-step.js" N --timeout-ms 240000
     ```
   - Or investigate why the test is consistently slow (check logs, network, page load times)

---

## Exit 4: run_timeout

**What happened:**
The whole run deadline expired. The attach run budget (default: 3 min + 45s per step, max 25 min) has been exhausted.

**Why this happens:**
- Too many steps for the allocated time
- Steps are taking much longer than 45s average
- Test got stuck somewhere and consumed the entire budget

**Actions:**

1. **Check progress to see how far the test got:**
   Read the error JSON's `progress` object to see `highestPassedStep`

2. **Decide on next action:**

   **If good progress was made (e.g., 8 out of 10 steps passed):**
   - Just need more time
   - Restart with extended timeout:
     ```bash
     node "$SKILL_DIR/scripts/start-run.js" --timeout-ms 1800000 ...
     ```

   **If poor progress (e.g., stuck on step 2):**
   - Investigate why steps are so slow
   - Check logs for bottlenecks
   - Fix slow steps before restarting

3. **Restart the run:**
   ```bash
   node "$SKILL_DIR/scripts/stop-run.js" --clean-port
   node "$SKILL_DIR/scripts/start-run.js" --port 9222 --log test-results/mcp-step.log --step-count <N> --timeout-ms <extended> --clean-port -- <attach_command>
   ```

---

## Important Notes

### Do NOT manually check process with `ps aux`

**Why this is wrong:**
- `ps aux` is a Unix/Linux command that doesn't exist on Windows
- Always returns "No process found" on Windows
- Causes false "process terminated" diagnoses

**What to do instead:**
- Trust the exit codes from `wait-for-step.js`
- Only use the double-check on Exit 2 (with correct platform-specific commands)
- Resolve the active `runId` from `latest-run.json`, then read the PID from `mcp-bridge/<runId>/launch.json`

### Trust the exit codes

`wait-for-step.js` already does comprehensive process monitoring:
- Checks process liveness every 500ms during the wait
- Uses platform-correct commands (`tasklist` on Windows, `kill -0` on Unix)
- Uses the launcher-owned run root PID as the canonical liveness signal, with `actualTestPid` kept as diagnostic metadata when available

The exit codes are reliable - don't second-guess them with manual checks.

### The race condition

Exit 2 means "process was alive during the entire wait period". But between the last check and the exit, the process could have died. That's why we do ONE double-check on Exit 2.

This is NOT the same as "Exit 2 means maybe dead, maybe alive" - it specifically means "was alive, but check one more time before proceeding".

### Reading the PID correctly

Resolve the run from `latest-run.json`, then read the canonical launcher PID from `launch.json`:
```bash
node -e "const fs=require('fs'); const path=require('path'); const latest=JSON.parse(fs.readFileSync('mcp-bridge/latest-run.json','utf8')); const launch=JSON.parse(fs.readFileSync(path.join('mcp-bridge', latest.runId, 'launch.json'),'utf8')); console.log(launch.pid)"
```

**Why `launch.json`?**
`latest-run.json` now acts as the active-run pointer. The canonical launcher-owned process metadata is stored in `mcp-bridge/<runId>/launch.json`, which avoids runtime code overwriting PID or timeout fields during the scenario.
