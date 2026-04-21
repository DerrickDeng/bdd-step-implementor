# Code Patterns for Step Implementation

Reference this file when writing new step implementations (A7). Choose the pattern that best matches the step's intent. If multiple patterns apply, combine them.

The code examples below illustrate **structural patterns** — how to set up interception before a click, how to pass values via World, etc. The actual syntax (how `page` is accessed, how World properties are declared, how POs are called from step-defs) must follow the project conventions from `.claude/project-profile.json` and the representative files read in Phase 0. Read the examples for the *shape* of the solution, then write code that fits the project.

**Important:** The examples below use `this.page` and `this.pages` for brevity. Your project may use a different access pattern — check `page_access.pattern` in the profile:
- `world_property`: `this.page` directly
- `page_manager`: `this.pages.xxxPage.method()` for step-defs; `this.page` for PO methods
- `static_singleton`: `BasePage.basePage` or similar static access

---

## Locator Selection Priority

Pick the highest-priority option that uniquely identifies the element. Don't combine strategies or add fallbacks.

1. **`page.getByTestId()`** — locate by `data-testid` attribute. E.g., `getByTestId('search-input')`. Stable test contract between frontend and test, immune to content/style changes.
2. **`page.getByRole()`** — locate by explicit and implicit accessibility attributes. E.g., `getByRole('button', { name: 'Submit' })`. Preferred for interactive elements because it mirrors how users find them.
3. **`page.getByText()`** — locate by text content. E.g., `getByText('View Latest News')`. Good for static labels, fragile if text is dynamic or localized.
4. **`page.getByLabel()`** — locate a form control by associated label's text. E.g., `getByLabel('Email')`. Ideal for form elements.
5. **`page.getByPlaceholder()`** — locate an input by placeholder. E.g., `getByPlaceholder('Search...')`.
6. **`page.getByAltText()`** — locate an element, usually image, by its text alternative. E.g., `getByAltText('Company logo')`.
7. **`page.getByTitle()`** — locate an element by its title attribute. E.g., `getByTitle('Close dialog')`.
8. **`page.locator()` with CSS** — `locator('h2.section-title')`. Use only when options 1-7 aren't available. Avoid generated class names (like `sc-1kkgpdp`).
9. **XPath** — last resort. Use only when no other locator can uniquely identify the element.

## Accurate Locating

When a high-priority locator (getByRole, getByText, etc.) matches multiple elements, narrow it down with filtering or chaining — don't fall back to a lower-priority locator or use `.first()`/`.nth(0)` blindly.

- **Filtering Locators** — narrow a broad locator by text, child, or descendant:
    ```typescript
    // Filter by text
    await page.getByRole('listitem').filter({ hasText: 'Product 2' });
    // Filter by not having text
    await page.getByRole('listitem').filter({ hasNotText: 'Out of stock' });
    // Filter by child/descendant
    await page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Product 2' }) });
    // Filter by not having child/descendant
    await page.getByRole('listitem').filter({ hasNot: page.getByRole('heading', { name: 'Product 2' }) });
    ```

- **Chaining Locators** — scope a locator within the result of another:
    ```typescript
    const product = page.getByRole('listitem').filter({ hasText: 'Product 2' });
    await product.getByRole('button', { name: 'Add to cart' }).click();
    ```

- **Avoid `.first()` / `.nth(0)` blindly** — only use when you specifically intend to select the first item in a list. If you're using it to "fix" a strict mode violation, that means the locator isn't precise enough — use filter or chain instead.

---

## Determinism Rules

Flaky tests waste everyone's time. Every implementation must be deterministic:

- Pick ONE locator per element using the priority above
- Never mix locator strategies within a single method — switching between e.g. `getByRole` and CSS in the same method signals unclear element identity; pick one and commit
- No if/else fallback selectors — if a method handles different parameters, use a parameterized locator pattern, not branching
- No retry loops or speculative selector chains — these mask the real failure and produce tests that pass intermittently
- When uncertain which selector is correct, re-analyze the snapshot and pick the single best match

---

## Pattern: API Request/Response Interception

When a step needs to verify or wait for an API call, use `waitForResponse` to avoid timing issues:

```typescript
async submitFormAndVerifyResponse() {
    const responsePromise = this.page.waitForResponse(
        resp => resp.url().includes('/api/submit') && resp.status() === 200
    );
    await this.page.getByRole('button', { name: 'Submit' }).click();
    const response = await responsePromise;
    const body = await response.json();
    expect(body.status).toBe('success');
}
```

Key points:
- Set up `waitForResponse` **before** the action that triggers the request
- Match on URL pattern + status code
- Parse response body for assertion if needed

---

## Pattern: World State — Cross-Step Value Passing

When one step captures a value and a later step validates it, use the World object to carry state across steps. This is the only sanctioned way to share data between steps.

Step definitions:
```typescript
When('I note the order number', async function(this: CustomWorld) {
    this.savedOrderNumber = await this.pages.orderPage.getOrderNumber();
});

Then('the confirmation shows the same order number', async function(this: CustomWorld) {
    await this.pages.confirmPage.verifyOrderNumber(this.savedOrderNumber);
});
```

Page Object:
```typescript
async getOrderNumber(): Promise<string> {
    return await this.page.locator('[data-testid="order-number"]').innerText();
}

async verifyOrderNumber(expected: string) {
    await expect(this.page.locator('[data-testid="confirm-order-number"]')).toHaveText(expected);
}
```

Key points:
- Declare the property on CustomWorld (or use dynamic assignment if the project allows it)
- The getter PO method returns the value; the verifier PO method takes it as a parameter
- Step-def is pure delegation — no `expect()` in the step-def

---

## Pattern: Parameterized Element Selection

When a method must handle different options (e.g., clicking different tabs, selecting different menu items), use a lookup map — not if/else branching:

```typescript
private tabSelectors: Record<string, string> = {
    'Overview': '[data-testid="tab-overview"]',
    'Details': '[data-testid="tab-details"]',
    'Settings': '[data-testid="tab-settings"]',
};

async clickTab(tabName: string) {
    const selector = this.tabSelectors[tabName];
    if (!selector) throw new Error(`Unknown tab: ${tabName}`);
    await this.page.locator(selector).click();
}
```

If all options share the same locator pattern, even simpler:

```typescript
async clickTab(tabName: string) {
    await this.page.getByRole('tab', { name: tabName }).click();
}
```

---

## Pattern: Table / List Validation

When verifying a table or list of items:

```typescript
async verifyTableHeaders(expectedHeaders: string[]) {
    const headers = this.page.locator('table thead th');
    await expect(headers).toHaveCount(expectedHeaders.length);
    for (let i = 0; i < expectedHeaders.length; i++) {
        await expect(headers.nth(i)).toHaveText(expectedHeaders[i]);
    }
}

async verifyTableRowCount(expected: number) {
    const rows = this.page.locator('table tbody tr');
    await expect(rows).toHaveCount(expected);
}

async verifyTableCellValue(row: number, col: number, expected: string) {
    const cell = this.page.locator(`table tbody tr:nth-child(${row}) td:nth-child(${col})`);
    await expect(cell).toHaveText(expected);
}
```

For DataTable from Cucumber:
```typescript
Then('I should see the following users:', async function(this: CustomWorld, dataTable: DataTable) {
    const expected = dataTable.hashes(); // [{name: 'Alice', role: 'Admin'}, ...]
    await this.pages.usersPage.verifyUserTable(expected);
});
```

---

## Pattern: Waiting for Dynamic Content

When content appears after loading/animation:

```typescript
async waitForDataToLoad() {
    // Wait for loading indicator to disappear
    await this.page.locator('[data-testid="loading-spinner"]')
        .waitFor({ state: 'hidden', timeout: 10000 });
    // Then verify content is present
    await expect(this.page.locator('.data-table')).toBeVisible();
}
```

When content appears after navigation:

```typescript
async navigateAndWait(url: string) {
    await this.page.goto(url);
    await this.page.waitForLoadState('networkidle');
}
```

---

## Pattern: File Download Verification

```typescript
async downloadAndVerify(buttonName: string) {
    const downloadPromise = this.page.waitForEvent('download');
    await this.page.getByRole('button', { name: buttonName }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
}
```

Key points:
- Set up `waitForEvent('download')` **before** the click
- Verify filename pattern, not exact name (which may be dynamic)

---

## Pattern: Assertions in Page Object

Assertions (`expect(...)`) always go in the Page Object method, never in the step definition. Step definitions are pure delegation.

```typescript
// Page Object — correct
async verifyPageTitle(expected: string) {
    await expect(this.page).toHaveTitle(expected);
}

async verifyElementVisible(testId: string) {
    await expect(this.page.getByTestId(testId)).toBeVisible();
}

// Step definition — correct (pure delegation)
Then('the page title is {string}', async function(this: CustomWorld, title: string) {
    await this.pages.homePage.verifyPageTitle(title);
});
```

---

## Pattern: Dropdown / Select Interaction

```typescript
async selectOption(label: string, value: string) {
    await this.page.getByLabel(label).selectOption(value);
}

// For custom dropdowns (non-native select)
async selectCustomDropdownOption(dropdownTestId: string, optionText: string) {
    await this.page.getByTestId(dropdownTestId).click();
    await this.page.getByRole('option', { name: optionText }).click();
}
```

---

## Pattern: Scenario Outline Parameterized Methods

Scenario Outline steps must be parameterized — methods accept parameters, never hardcode any Examples value.

In most cases, a straightforward parameterized implementation covers all rows naturally:

```typescript
// PO method — parameter used directly in locator and assertion
async clickOption(option: string) {
    await this.page.getByText(option).click();
}

async verifyKeywordVisible(keyword: string) {
    await expect(this.page.getByText(keyword)).toBeVisible();
}
```

When different parameter values cause fundamentally different interactions (discovered during B3 diagnosis, not assumed upfront), use if/else branching within the same method:

```typescript
async handleDownload(format: string) {
    if (format === 'PDF') {
        await this.page.getByRole('link', { name: 'Preview' }).click();
    } else if (format === 'CSV') {
        const download = await this.page.waitForEvent('download');
        // ...
    } else {
        throw new Error(`Unknown format: ${format}`);
    }
}
```

This is parameter-based business logic branching, not selector fallbacks — it will not trigger the quality gate (which only flags `if` combined with `locator`/`selector` keywords).

This pattern is a fallback for B3 diagnosis, not the default. A7 should always try the generic parameterized approach first.
