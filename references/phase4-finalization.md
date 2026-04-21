# Phase 4: Finalization Patterns

This reference provides detailed guidance for converting validated `impl.js` files into final production code (Page Object methods and Step Definition bindings).

**Key Principle**: Always match the project's actual style by referring to the files you read in Phase 0. Never assume or hardcode patterns.

---

## Table of Contents

1. [Page Object Method Patterns](#page-object-method-patterns)
2. [Step Definition Binding Patterns](#step-definition-binding-patterns)
3. [Common Pitfalls](#common-pitfalls)

---

## Page Object Method Patterns

### Converting from impl.js to Page Object Methods

When `page_access.pattern` is `static_singleton`, the conversion requires adapting the page access pattern.

#### In impl.js (temporary bridge file)

Because `impl.js` runs outside a class context, it must use `BasePage.basePage` directly:

```javascript
const BasePage = require('../../src/pages/base.page').default;

module.exports = async function () {
  await BasePage.basePage.getByRole('dialog').click();
};
```

This is correct for `impl.js` but **must be changed** for the final Page Object method.

#### In Final Page Object Methods

**Step 1**: Check the Page Object files you read in Phase 0. Look for how they use Playwright APIs like:
- `getByRole()`
- `locator()`
- `getByTestId()`
- `getByText()`

**Step 2**: Identify which pattern the project uses:

**Pattern A: `this.page` (most common)**
```typescript
// Observed in Phase 0:
async existingMethod() {
  const element = this.page.getByTestId('some-id');
  await this.page.locator('.some-class').click();
}

// Your new method should use:
async myNewMethod() {
  const dialog = this.page.getByRole('dialog');
  await dialog.click();
}
```

**Pattern B: BasePage wrapper methods**
```typescript
// Observed in Phase 0:
async existingMethod() {
  await this.click(locators.someButton);
  await this.expectToBeVisible(locators.someElement);
}

// Your new method should use:
async myNewMethod() {
  await this.click(locators.dialogButton);
  await this.expectToBeVisible(locators.dialogHeader);
}
```

**Pattern C: Direct static access (rare)**
```typescript
// Observed in Phase 0:
async existingMethod() {
  await BasePage.basePage.getByRole('button').click();
}

// Your new method should use:
async myNewMethod() {
  await BasePage.basePage.getByRole('dialog').click();
}
```

#### How to Determine the Correct Pattern

1. Open the Page Object files from Phase 0 in your editor
2. Search for `getByRole`, `locator`, `getByTestId` - note what comes before them
3. If you see `this.page.getByRole` → use Pattern A
4. If you see `this.click(` or `this.expectToBeVisible(` → use Pattern B
5. If you see `BasePage.basePage.getByRole` → use Pattern C

**Do NOT assume** the pattern based on examples in this reference. Always verify by reading actual project code.

#### Example Transformation

Assuming the project uses `this.page` (Pattern A):

```typescript
// ❌ WRONG - Directly copying impl.js pattern
async agentClickFirstProductCard(world: any) {
  const productIdElement = BasePage.basePage.locator('p').filter({ hasText: /^AUTO/ }).first();
  // ...
}

// ✓ CORRECT - Adapted to project's this.page pattern
async agentClickFirstProductCard(world: any) {
  const productIdElement = this.page.locator('p').filter({ hasText: /^AUTO/ }).first();
  // ...
}
```

---

## Step Definition Binding Patterns

### How to Call Page Objects

Check the step-definition files from Phase 0 to see how they call Page Object methods.

**Pattern A: PageObjects Singleton (most common)**
```typescript
// File header (copied from existing step-def files):
import { PageObjects } from "../../pages/page.objects";
let pageObjects = PageObjects.getInstance();

// Step implementation:
const myStep = async function (this: ScenarioWorld) {
  await pageObjects.myPage.myMethod();
}
```

**Pattern B: World's pages Property**
```typescript
// Step implementation:
const myStep = async function (this: ScenarioWorld) {
  await this.pages.myPage.myMethod();
}
```

**Pattern C: Other Patterns**

Copy exactly what you observed in Phase 0. Don't invent new patterns.

### Function Definition Style

Projects use different styles for defining step functions. Check Phase 0 files to determine which one your project uses.

**Style A: Named Function Constants (most common)**
```typescript
// Define the function
const agentClicksFirstProductCard = async function (this: ScenarioWorld) {
  await pageObjects.productDetailsAgentPage.agentClickFirstProductCard(this);
}

// Bind to step text
When("agent clicks the first product card", agentClicksFirstProductCard);
```

**Style B: Inline Functions**
```typescript
Then("agent will see the product details page", async function(this: ScenarioWorld) {
  await pageObjects.productDetailsAgentPage.agentVerifyProductDetailsPage();
});
```

**Style C: Mixed (some projects use both)**

Some projects use named constants for most steps, but inline functions for parameterized steps or one-off cases. Follow the project's convention.

### Imports and Initialization

Copy the exact import statements and initialization code from existing step-definition files:

**Common Pattern**:
```typescript
import { Given, Then, When } from "@cucumber/cucumber";
import { ScenarioWorld } from "../../setup/world";
import { PageObjects } from "../../pages/page.objects";

let pageObjects = PageObjects.getInstance();
```

**Variations** you might see:
- Different import paths (e.g., `"../../../setup/world"`)
- Different World type names
- Additional imports for utilities or test data
- Different PageObjects initialization patterns

### Checklist for Step Definitions

Before finalizing your step-definition code, verify you've matched all these elements from Phase 0:

- [ ] Import statements (exact packages and paths)
- [ ] World type annotation (`this: ScenarioWorld` or other)
- [ ] PageObjects initialization code
- [ ] Function definition style (named constant vs inline)
- [ ] How Page Object methods are called (`pageObjects.xxx` vs `this.pages.xxx`)
- [ ] Variable naming conventions
- [ ] Comment style (if the project uses comments for step functions)

---

## Common Pitfalls

### Pitfall 1: Using impl.js Pattern in Page Objects

**Wrong**:
```typescript
// In Page Object class
async myMethod() {
  await BasePage.basePage.getByRole('dialog').click(); // ❌ impl.js pattern!
}
```

**Right**:
```typescript
// After checking Phase 0 files, project uses this.page
async myMethod() {
  await this.page.getByRole('dialog').click(); // ✓ Matches project style
}
```

### Pitfall 2: Assuming PageObjects Access Pattern

**Wrong**:
```typescript
// Assuming without checking
When("step text", async function(this: ScenarioWorld) {
  await this.pages.myPage.myMethod(); // ❌ Assumption!
});
```

**Right**:
```typescript
// After reading Phase 0 step-def files, project uses singleton
let pageObjects = PageObjects.getInstance();

When("step text", async function(this: ScenarioWorld) {
  await pageObjects.myPage.myMethod(); // ✓ Matches project
});
```

### Pitfall 3: Inconsistent Function Style

**Wrong**:
```typescript
// Existing steps use named constants, but new step uses inline
const existingStep = async function (this: ScenarioWorld) { ... }
When("existing step", existingStep);

When("new step", async function(this: ScenarioWorld) { ... }); // ❌ Inconsistent!
```

**Right**:
```typescript
// All use the same style
const existingStep = async function (this: ScenarioWorld) { ... }
const newStep = async function (this: ScenarioWorld) { ... } // ✓ Consistent

When("existing step", existingStep);
When("new step", newStep);
```

### Pitfall 4: Wrong Import Paths

**Wrong**:
```typescript
// Guessing the import path
import { PageObjects } from "../../pages/page.objects"; // ❌ Might be wrong!
```

**Right**:
```typescript
// Copy exact import from existing step-def file in same directory
import { PageObjects } from "../../../pages/page.objects"; // ✓ Matches existing files
```

---

## Quick Reference: Conversion Checklist

When converting `impl.js` to final code, go through this checklist:

### Page Object Methods

1. ✓ Read Page Object files from Phase 0
2. ✓ Identify how they access Playwright APIs (`this.page` vs wrappers vs `BasePage.basePage`)
3. ✓ Replace `BasePage.basePage` in impl.js with the project's pattern
4. ✓ Keep assertions in PO methods (not in step-defs)
5. ✓ Use project's import style for `expect` if needed

### Step Definition Bindings

1. ✓ Read step-definition files from Phase 0
2. ✓ Copy exact import statements
3. ✓ Copy PageObjects initialization code
4. ✓ Use project's function definition style (named vs inline)
5. ✓ Use project's PO access pattern (`pageObjects.xxx` vs `this.pages.xxx`)
6. ✓ Match World type annotation
7. ✓ Delegate to PO methods (no direct page access in step-defs)

### Final Verification

1. ✓ Compile check passes (`tsc --noEmit`)
2. ✓ Code looks consistent with existing files
3. ✓ No hardcoded assumptions - everything based on Phase 0 observations
4. ✓ Run the final test to confirm it passes
