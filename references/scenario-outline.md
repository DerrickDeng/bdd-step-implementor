# Scenario Outline Handling

When Phase 1 detects a `Scenario Outline` with `Examples`, follow this document for supplementary handling. This does not change the overall Phase structure — it only adds Outline-specific behavior at key points.

---

## Detection

Deterministic check: the feature file contains `Scenario Outline:` followed by an `Examples:` (or `Example:`) block.

Record the following for later use:
- **scenario_type**: `"outline"`
- **row_count**: number of data rows in Examples (excluding the header row)
- **first_row_line**: the line number of the first DATA row in the feature file. **Critical**: This must be the first row AFTER the Examples header row, NOT the header itself.

  **How to identify the correct line:**
  1. Find the `Examples:` keyword in the feature file
  2. The next line is the **header row** (starts with `|` and contains placeholder names like `|loginUser|optValue|`)
  3. The line AFTER the header row is the **first data row** (contains actual values like `|uat TW_DIGI_USER2|111111|`)
  4. Use the line number of this first data row

  **Example:**
  ```gherkin
  Examples:                        # Line 18
    |loginUser          |optValue| # Line 19 ← header row (SKIP this)
    |uat TW_DIGI_USER2  |111111  | # Line 20 ← first data row (USE this)
  ```
  In this example, `first_row_line = 20`, NOT 19.

  **Important**: After adding the isolation tag in Phase 1 step 6, if the tag is inserted above the scenario line, all subsequent line numbers shift down by 1. Re-count from the modified feature file to get the final line number.

- **placeholders**: list of `<placeholder>` names found in template steps

---

## Implementation Queue

dry-run expands a Scenario Outline into N independent scenarios (one per data row). But the step-def binding and PO method are written only once — they are parameterized.

When building `implementation_queue`, use the template steps (original text with `<placeholder>`) as the basis. Deduplicate so each template step appears only once, in template order. Do not enqueue expanded steps separately.

---

## Attach Command

For Scenario Outline, `attach_command` targets the first data row only, scoped by the tag filter:
```
attach_command = <commands.attach_outline from project-profile.json, with {feature_path}, {line}, {tag_filter} filled in>
```

The `--tags` flag ensures only the target scenario runs even if other scenarios share the same feature file. `run_command` (tag-based, all rows) is used separately for Phase 4 final validation.

---

## Validation Rules

Phase 4 final validation runs all Examples rows via `run_command`. All rows must pass for the step to be marked PASS. Any row failing counts as one iteration. The limit is 6 iterations, same as plain `Scenario`.

A Scenario Outline with 4 rows or 40 rows — the limit is always 6. The implementation is one parameterized method; if 6 attempts cannot make all rows pass, human input is needed.

Cucumber error output includes the failing row's line number and parameter values. During failure diagnosis:
1. Extract the failing row's line number and parameter values from the error output
2. Use MCP to inspect the page state for that row and compare with the expected content
3. Compare what MCP shows across rows to identify page differences that cause the failure
4. Fix the implementation, then re-validate all rows with `run_command`

---

## Snapshot Reuse

Snapshot reuse rules for Scenario Outline are the same as for plain `Scenario` (see `cli-snapshot-rules.md`). Additional constraint: different parameter values represent different page states. A snapshot captured for one Examples row cannot be assumed valid for a different row.
