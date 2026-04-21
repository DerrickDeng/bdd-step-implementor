#!/usr/bin/env node
'use strict';

/**
 * discover-project.js
 *
 * Auto-discovers project structure for the mcp-step-implementor skill and
 * writes `.claude/project-profile.json`.
 *
 * This script replaces the old `framework-style-cache.md` approach.  It
 * programmatically inspects the project so that every script and the SKILL.md
 * workflow can read a single, structured profile instead of relying on
 * hardcoded defaults.
 *
 * Usage:
 *   node .claude/skills/mcp-step-implementor/scripts/discover-project.js [options]
 *
 * Options:
 *   --force         Overwrite an existing profile even if one already exists
 *   --run-doctor    Automatically run doctor.js after profile generation
 *   --profile=NAME  Use specific Cucumber profile (validates against cucumber.js)
 */

const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const ROOT = process.cwd();

// ─── Helpers ────────────────────────────────────────────────────────────────

function glob(pattern, base = ROOT) {
  const results = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        walk(full);
      } else if (entry.isFile()) {
        results.push(full);
      }
    }
  }
  walk(base);
  const re = globToRegex(pattern);
  return results.filter(f => re.test(path.relative(base, f))).sort();
}

function globToRegex(pattern) {
  // Expand brace alternatives: {ts,js} → (ts|js)
  let expanded = pattern.replace(/\{([^}]+)\}/g, (_, alts) => `(${alts.split(',').join('|')})`);
  const escaped = expanded
    .replace(/[.+^$[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '(?:.*/)?')   // **/ matches zero or more directories
    .replace(/\*\*/g, '.*')           // standalone **
    .replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

function readFile(relPath) {
  const abs = path.resolve(ROOT, relPath);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
}

function readJsonFile(relPath) {
  const content = readFile(relPath);
  if (!content) return null;
  try { return JSON.parse(content); } catch { return null; }
}

function relativePosix(from, to) {
  return path.relative(path.dirname(from), to).replace(/\\/g, '/');
}

// ─── Discover: Cucumber Config ──────────────────────────────────────────────

function discoverCucumberConfig() {
  const candidates = ['cucumber.js', 'cucumber.cjs', '.cucumberrc.json', '.cucumberrc.yaml', '.cucumberrc.yml'];
  for (const name of candidates) {
    if (fs.existsSync(path.join(ROOT, name))) {
      return name;
    }
  }
  return null;
}

/**
 * Discover all available profiles from cucumber config
 *
 * @param {string} configFile - Path to cucumber config file
 * @param {string} userSpecifiedProfile - Optional user-specified profile via --profile= flag
 * @returns {object} Profile information including all available profiles
 */
function discoverProfile(configFile, userSpecifiedProfile) {
  const defaultResult = {
    all_profiles: ['default'],
    needs_user_selection: false,
  };

  if (!configFile) return defaultResult;
  const content = readFile(configFile);
  if (!content) return defaultResult;

  // Try to parse JS/CJS config to find profile names.
  // The top-level keys of module.exports are profile names.
  try {
    // Strategy: require() the config file directly for reliable parsing
    const absConfig = path.resolve(ROOT, configFile);
    // Clear require cache to get fresh config
    delete require.cache[absConfig];
    const config = require(absConfig);
    const profileNames = Object.keys(config);

    if (profileNames.length === 0) {
      return defaultResult;
    }

    if (profileNames.length === 1 && profileNames[0] === 'default') {
      return {
        all_profiles: ['default'],
        needs_user_selection: false,
      };
    }

    // Multiple profiles detected
    const result = {
      all_profiles: profileNames,
      needs_user_selection: profileNames.length > 1,
    };

    // If user specified a profile via --profile= flag, validate it
    if (userSpecifiedProfile) {
      if (!profileNames.includes(userSpecifiedProfile)) {
        console.warn(`⚠ Warning: Specified profile "${userSpecifiedProfile}" not found in cucumber.js`);
        console.warn(`  Available profiles: ${profileNames.join(', ')}`);
        console.warn(`  Falling back to first available profile: ${profileNames[0]}`);
      } else {
        console.log(`✓ Using user-specified profile: ${userSpecifiedProfile}`);
        result.needs_user_selection = false; // User explicitly chose
      }
    }

    return result;
  } catch (err) {
    console.warn(`Warning: Could not parse cucumber config: ${err.message}`);
  }

  return defaultResult;
}

function discoverStepDefRequirePaths(configFile, profileName) {
  if (!configFile) return [];
  const content = readFile(configFile);
  if (!content) return [];

  try {
    // Look for require: [...] in the profile
    const requireMatch = content.match(/require\s*:\s*\[([^\]]+)\]/);
    if (requireMatch) {
      const paths = [];
      const strRegex = /'([^']+)'|"([^"]+)"/g;
      let m;
      while ((m = strRegex.exec(requireMatch[1])) !== null) {
        paths.push(m[1] || m[2]);
      }
      return paths;
    }
  } catch { /* fall through */ }
  return [];
}

// ─── Discover: Directory Structure ──────────────────────────────────────────

function discoverDirectories() {
  // Find step-definition directory
  const stepDefCandidates = ['src/step-definitions', 'src/steps', 'test/steps', 'test/step-definitions', 'tests/steps'];
  let stepDefDir = null;
  for (const dir of stepDefCandidates) {
    if (fs.existsSync(path.join(ROOT, dir))) {
      // Verify it has .steps.ts or .steps.js files
      const files = glob(`${dir}/**/*.steps.{ts,js}`);
      if (files.length > 0) {
        stepDefDir = dir;
        break;
      }
    }
  }
  // Fallback: check cucumber config require paths
  if (!stepDefDir) {
    for (const dir of stepDefCandidates) {
      if (fs.existsSync(path.join(ROOT, dir))) {
        stepDefDir = dir;
        break;
      }
    }
  }

  // Find page-object directory
  const poCandidates = ['src/pages', 'src/page-objects', 'test/pages', 'test/page-objects', 'tests/pages'];
  let poDir = null;
  for (const dir of poCandidates) {
    if (fs.existsSync(path.join(ROOT, dir))) {
      poDir = dir;
      break;
    }
  }

  // Find support directory
  const supportCandidates = ['src/support', 'src/setup', 'test/support', 'tests/support'];
  let supportDir = null;
  for (const dir of supportCandidates) {
    if (fs.existsSync(path.join(ROOT, dir))) {
      supportDir = dir;
      break;
    }
  }

  return { stepDefDir, poDir, supportDir };
}

// ─── Discover: Hooks ────────────────────────────────────────────────────────

function discoverHooksFile() {
  const hookPatterns = [
    'src/support/hooks.ts',
    'src/support/hooks.js',
    'src/step-definitions/hooks/hooks.ts',
    'src/step-definitions/hooks/hooks.js',
    'src/steps/hooks/hooks.ts',
    'src/steps/hooks/hooks.js',
    'test/support/hooks.ts',
    'test/support/hooks.js',
  ];

  for (const p of hookPatterns) {
    if (fs.existsSync(path.join(ROOT, p))) {
      return p;
    }
  }

  // Broader glob search
  const found = glob('src/**/hooks.{ts,js}');
  if (found.length > 0) return path.relative(ROOT, found[0]);

  return null;
}

// ─── Discover: World ────────────────────────────────────────────────────────

function discoverWorld(supportDir) {
  const worldCandidates = [
    supportDir ? `${supportDir}/world.ts` : null,
    supportDir ? `${supportDir}/world.js` : null,
    'src/support/world.ts',
    'src/setup/world.ts',
    'src/step-definitions/support/world.ts',
  ].filter(Boolean);

  let worldFile = null;
  for (const p of worldCandidates) {
    if (fs.existsSync(path.join(ROOT, p))) {
      worldFile = p;
      break;
    }
  }

  if (!worldFile) {
    const found = glob('src/**/world.{ts,js}');
    if (found.length > 0) worldFile = path.relative(ROOT, found[0]);
  }

  if (!worldFile) {
    return {
      file: null,
      type: 'CustomWorld',
      hasPageProperty: false,
      hasContextProperty: false,
      hasPagesProperty: false,
    };
  }

  const content = readFile(worldFile);
  if (!content) {
    return { file: worldFile, type: 'CustomWorld', hasPageProperty: false, hasContextProperty: false, hasPagesProperty: false };
  }

  // Extract world class name
  const classMatch = content.match(/export\s+class\s+(\w+)/);
  const worldType = classMatch ? classMatch[1] : 'CustomWorld';

  // Check for page property
  const hasPageProperty = /\bpage\s*[!?]?\s*:\s*Page\b/.test(content) || /\bpage\s*:\s*Page\b/.test(content);

  // Check for context property
  const hasContextProperty = /\bcontext\s*[!?]?\s*:\s*BrowserContext\b/.test(content);

  // Check for pages/PO manager property
  const hasPagesProperty = /\bpages\b/.test(content) && /PageObjectManager|PageManager/.test(content);

  return { file: worldFile, type: worldType, hasPageProperty, hasContextProperty, hasPagesProperty };
}

// ─── Discover: Page Access Pattern ──────────────────────────────────────────

function discoverPageAccess(world, stepDefDir, poDir, hooksFile) {
  // Strategy 1: Check hooks file (most reliable)
  if (hooksFile && fs.existsSync(hooksFile)) {
    const content = fs.readFileSync(hooksFile, 'utf8');

    // Pattern: BasePage.basePage = page — static singleton
    // Also check: SomeClass.staticPage = page
    const staticAssignMatch = content.match(/(\w+)\.(\w+)\s*=\s*(?:pageObj|page)\s*;/);
    if (staticAssignMatch) {
      return {
        pattern: 'static_singleton',
        stepExpression: `${staticAssignMatch[1]}.${staticAssignMatch[2]}`,
        implExpression: `${staticAssignMatch[1]}.${staticAssignMatch[2]}`,
        implPageExpression: `${staticAssignMatch[1]}.${staticAssignMatch[2]}`,
      };
    }

    // Pattern: this.pages = new PageManager(...) — page manager
    if (/this\.pages\s*=\s*new\s+\w+/.test(content)) {
      return {
        pattern: 'page_manager',
        stepExpression: 'this.pages.{pageInstance}.{method}()',
        implExpression: 'this.pages',
        implPageExpression: 'this.page',
      };
    }

    // Pattern: this.page = page — world property
    if (/this\.page\s*=\s*(?:pageObj|page)/.test(content)) {
      return {
        pattern: 'world_property',
        stepExpression: 'this.page',
        implExpression: 'this.page',
        implPageExpression: 'this.page',
      };
    }
  }

  // Strategy 2: Fallback to World properties
  if (world.hasPagesProperty) {
    return {
      pattern: 'page_manager',
      stepExpression: 'this.pages.{pageInstance}.{method}()',
      implExpression: 'this.pages',
      implPageExpression: 'this.page',
    };
  }

  if (world.hasPageProperty) {
    return {
      pattern: 'world_property',
      stepExpression: 'this.page',
      implExpression: 'this.page',
      implPageExpression: 'this.page',
    };
  }

  // Strategy 3: Check for static BasePage pattern in PO files
  if (poDir) {
    const baseFiles = glob(`${poDir}/**/[Bb]ase*.{ts,js}`);
    for (const f of baseFiles) {
      const content = fs.readFileSync(f, 'utf8');
      if (/static\s+\w+\s*:\s*Page/.test(content) || /static\s+basePage/.test(content)) {
        const className = path.basename(f, path.extname(f));
        return {
          pattern: 'static_singleton',
          stepExpression: `${className}.basePage`,
          implExpression: `${className}.basePage`,
          implPageExpression: `${className}.basePage`,
        };
      }
    }
  }

  // Default
  return {
    pattern: 'world_property',
    stepExpression: 'this.page',
    implExpression: 'this.page',
    implPageExpression: 'this.page',
  };
}

// ─── Discover: Representative Files ─────────────────────────────────────────

function discoverRepresentativeFiles(stepDefDir, poDir) {
  const result = {};

  if (poDir) {
    const poFiles = glob(`${poDir}/**/*.ts`)
      .map(f => path.relative(ROOT, f))
      .filter(f => !/[Bb]ase[Pp]age/.test(path.basename(f)) && !f.includes('Manager'));
    if (poFiles.length > 0) result.page_object = poFiles[0];
  }

  if (stepDefDir) {
    const stepFiles = glob(`${stepDefDir}/**/*.ts`)
      .map(f => path.relative(ROOT, f))
      .filter(f => f.endsWith('.steps.ts') || f.endsWith('.steps.js'));
    if (stepFiles.length > 0) result.step_def = stepFiles[0];
  }

  return result;
}

// ─── Discover: Conventions ──────────────────────────────────────────────────

function discoverConventions(poDir, stepDefDir) {
  let poSuffix = '.ts';
  let stepDefSuffix = '.steps.ts';

  if (poDir) {
    const poFiles = glob(`${poDir}/**/*.ts`);
    if (poFiles.some(f => f.endsWith('.page.ts'))) poSuffix = '.page.ts';
  }

  if (stepDefDir) {
    const stepFiles = glob(`${stepDefDir}/**/*.ts`);
    if (stepFiles.some(f => f.endsWith('.steps.ts'))) stepDefSuffix = '.steps.ts';
  }

  return { poSuffix, stepDefSuffix };
}

// ─── Discover: TSC Command ──────────────────────────────────────────────────

function discoverTscCommand() {
  // Check if tsc is available
  try {
    const result = childProcess.spawnSync('npx', ['tsc', '--version'], {
      cwd: ROOT, encoding: 'utf8', shell: true, timeout: 10000,
    });
    if (!result.error && result.status === 0) {
      return 'npx tsc --noEmit';
    }
  } catch { /* fall through */ }

  return 'npx tsc --noEmit';
}

// ─── Discover: Commands ─────────────────────────────────────────────────────

/**
 * Discover how to run Cucumber in this project.
 *
 * Strategy:
 *  1. Parse every npm script that invokes cucumber — classify what each one
 *     already bakes in (env vars, profile, tags, etc.)
 *  2. Pick the "cleanest" base script — one that does NOT hardcode --tags
 *     or --profile, so we can append our own freely.
 *  3. If no clean script exists, fall back to `npx cucumber-js`.
 *  4. Determine whether --profile= is needed from the cucumber config.
 *  5. Assemble command templates with placeholders.
 *
 * The output uses placeholders: {feature_path}, {tag_filter}, {line}
 */
function discoverCommands(cucumberConfig, profileName, profileFlag) {
  const pkg = readJsonFile('package.json');

  // ── Step 1: Parse all cucumber-related npm scripts ──────────────────────
  const scriptAnalysis = [];
  if (pkg && pkg.scripts) {
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      if (!/cucumber-js|cucumber/.test(cmd)) continue;
      if (/dry.run|dry-run/i.test(name)) continue;

      scriptAnalysis.push({
        name,
        cmd,
        hasProfile: /--profile[\s=]/.test(cmd),           // --profile=xxx or --profile xxx
        hasTags: /--tags[\s=]/.test(cmd),                  // --tags "@xxx"
        hasEnvPrefix: /^(npx\s+)?(cross-env|env)\s/.test(cmd.trim()) || /^\w+=\S+\s/.test(cmd.trim()),
        isPlainCucumber: /^(npx\s+)?cucumber-js(\s|$)/.test(cmd.trim()),
      });
    }
  }

  // ── Step 2: Pick the best base script ───────────────────────────────────
  // Priority:
  // 1. Script name matches profile name (e.g., "uat" script for "uat" profile)
  // 2. Clean script (no profile, no tags)
  // 3. Script with profile only
  // 4. Script with both profile and tags
  // 5. Fallback to npx cucumber-js
  let baseCommand = null;
  let needsProfileFlag = true;
  let needsTagsFlag = true;

  // First choice: script name matches the profile name
  if (profileName) {
    const matchingScript = scriptAnalysis.find(s => s.name === profileName);
    if (matchingScript) {
      baseCommand = `npm run ${matchingScript.name} --`;
      // If the matching script has --profile baked in, we don't need the flag
      if (matchingScript.hasProfile) {
        needsProfileFlag = false;
        console.log(`  Command source: package.json "${matchingScript.name}" → ${matchingScript.cmd} (profile matched by name, profile baked in)`);
      } else {
        console.log(`  Command source: package.json "${matchingScript.name}" → ${matchingScript.cmd} (profile matched by name)`);
      }
    }
  }

  // Second choice: a clean script with no --profile and no --tags
  if (!baseCommand) {
    const cleanScripts = scriptAnalysis.filter(s => !s.hasProfile && !s.hasTags);
    // Prefer the shortest/simplest name (e.g., "test" over "test:headless")
    cleanScripts.sort((a, b) => a.name.length - b.name.length);

    if (cleanScripts.length > 0) {
      const pick = cleanScripts[0];
      baseCommand = `npm run ${pick.name} --`;
      console.log(`  Command source: package.json "${pick.name}" → ${pick.cmd}`);
    }
  }

  // Third choice: a script with --profile but no --tags
  if (!baseCommand) {
    const profileOnlyScripts = scriptAnalysis.filter(s => s.hasProfile && !s.hasTags);
    if (profileOnlyScripts.length > 0) {
      const pick = profileOnlyScripts[0];
      baseCommand = `npm run ${pick.name} --`;
      needsProfileFlag = false;   // profile is baked in
      console.log(`  Command source: package.json "${pick.name}" → ${pick.cmd} (profile baked in)`);
    }
  }

  // Fourth choice: a script with both --profile and --tags
  // We can still use it, but we can't append our own --tags
  if (!baseCommand) {
    const fullScripts = scriptAnalysis.filter(s => s.hasProfile && s.hasTags);
    if (fullScripts.length > 0) {
      const pick = fullScripts[0];
      baseCommand = `npm run ${pick.name} --`;
      needsProfileFlag = false;
      // NOTE: --tags is baked in, but we MUST still append our own isolation tag.
      // Cucumber merges multiple --tags with AND, so this is safe.
      console.log(`  Command source: package.json "${pick.name}" → ${pick.cmd} (profile+tags baked in)`);
    }
  }

  // Fallback: npx cucumber-js
  if (!baseCommand) {
    baseCommand = 'npx cucumber-js';
    console.log(`  Command source: npx cucumber-js (direct, no npm script found)`);
  }

  // ── Step 3: Determine if --profile= is actually needed ──────────────────
  if (needsProfileFlag && cucumberConfig) {
    try {
      const absConfig = path.resolve(ROOT, cucumberConfig);
      delete require.cache[absConfig];
      const config = require(absConfig);
      const profiles = Object.keys(config);

      if (profiles.length === 0) {
        // No profiles at all
        needsProfileFlag = false;
        console.log(`  Profile: none needed (config exports no profiles)`);
      } else if (profiles.length === 1 && profiles[0] === 'default') {
        // Only 'default' — Cucumber uses it automatically, flag is optional but harmless
        console.log(`  Profile: default (explicit, cucumber uses it automatically)`);
      }
    } catch { /* fall through */ }
  }

  // ── Step 4: Assemble templates ──────────────────────────────────────────
  const effectiveProfileFlag = needsProfileFlag ? profileFlag : '';
  const parts = [baseCommand, effectiveProfileFlag].filter(Boolean);
  const baseWithProfile = parts.join(' ');

  // ── Step 5: Record all scripts for LLM reference ────────────────────────
  const availableScripts = {};
  for (const s of scriptAnalysis) {
    availableScripts[s.name] = s.cmd;
  }

  return {
    base: baseCommand,
    profile_flag: effectiveProfileFlag,
    dry_run: `${baseWithProfile} {feature_path} --dry-run`,
    run: `${baseWithProfile} --tags "{tag_filter}"`,
    attach_plain: `${baseWithProfile} --tags "{tag_filter}"`,
    attach_outline: `${baseWithProfile} {feature_path}:{line} --tags "{tag_filter}"`,
    available_scripts: availableScripts,
  };
}

/**
 * Discover commands for all available profiles
 *
 * @param {string} cucumberConfig - Path to cucumber config file
 * @param {string[]} allProfiles - Array of all profile names
 * @returns {object} Map of profile name to command templates
 */
function discoverAllProfileCommands(cucumberConfig, allProfiles) {
  const profilesMap = {};

  for (const profileName of allProfiles) {
    const commands = discoverCommands(cucumberConfig, profileName);
    profilesMap[profileName] = {
      flag: commands.profile_flag,
      base_command: commands.base,
      commands: {
        dry_run: commands.dry_run,
        run: commands.run,
        attach_plain: commands.attach_plain,
        attach_outline: commands.attach_outline,
      }
    };
  }

  return profilesMap;
}

function verifyCucumberAvailable() {
  try {
    const result = childProcess.spawnSync('npx', ['cucumber-js', '--help'], {
      cwd: ROOT, encoding: 'utf8', timeout: 15000, shell: true,
    });
    return !result.error && (result.status === 0 || result.status === 1);
  } catch {
    return false;
  }
}

// ─── Build Profile ──────────────────────────────────────────────────────────

function buildProfile(userSpecifiedProfile) {
  console.log('Discovering project structure...\n');

  // Cucumber config
  const cucumberConfig = discoverCucumberConfig();
  const profileInfo = discoverProfile(cucumberConfig, userSpecifiedProfile);
  console.log(`  Cucumber config: ${cucumberConfig || '(not found)'}`);
  console.log(`  Profiles available: ${profileInfo.all_profiles.join(', ')}`);

  if (profileInfo.needs_user_selection && !userSpecifiedProfile) {
    console.log(`  ⚠ Multiple profiles detected. Profile selection happens in SKILL.md Phase 1.`);
  }

  // Directories
  const { stepDefDir, poDir, supportDir } = discoverDirectories();
  console.log(`  Step definitions: ${stepDefDir || '(not found)'}`);
  console.log(`  Page objects: ${poDir || '(not found)'}`);
  console.log(`  Support: ${supportDir || '(not found)'}`);

  // Hooks
  const hooksFile = discoverHooksFile();
  console.log(`  Hooks: ${hooksFile || '(not found)'}`);

  // World
  const world = discoverWorld(supportDir);
  console.log(`  World file: ${world.file || '(not found)'}`);
  console.log(`  World type: ${world.type}`);
  console.log(`  World has page: ${world.hasPageProperty}`);
  console.log(`  World has pages: ${world.hasPagesProperty}`);

  // Page access
  const pageAccess = discoverPageAccess(world, stepDefDir, poDir, hooksFile);
  console.log(`  Page access pattern: ${pageAccess.pattern}`);

  // Stub file
  const stubStepDef = stepDefDir
    ? `${stepDefDir}/_mcp-stubs.steps.ts`
    : 'src/steps/_mcp-stubs.steps.ts';

  // World import from stub file
  const worldImportFromStub = world.file
    ? relativePosix(stubStepDef, world.file).replace(/\.ts$/, '')
    : '../support/world';

  // Conventions
  const conventions = discoverConventions(poDir, stepDefDir);

  // Page URL expression for pause JSON (used in generate-stubs.js)
  let pageUrlExpression;
  if (pageAccess.pattern === 'world_property' && world.hasPageProperty) {
    pageUrlExpression = '(world as any).page?.url?.()';
  } else if (pageAccess.pattern === 'page_manager' && world.hasPageProperty) {
    pageUrlExpression = '(world as any).page?.url?.()';
  } else if (pageAccess.pattern === 'static_singleton') {
    pageUrlExpression = "''"; // Can't access static page from stub context easily
  } else {
    pageUrlExpression = '(world as any).page?.url?.()';
  }

  // Command templates — discover for all profiles
  const allProfileCommands = discoverAllProfileCommands(cucumberConfig, profileInfo.all_profiles);

  // For backward compatibility, use the first profile for the commands section
  const firstProfile = profileInfo.all_profiles[0];
  const firstProfileCommands = allProfileCommands[firstProfile];

  const profileObj = {
    version: 1,
    discovered_at: new Date().toISOString(),

    directories: {
      step_definitions: stepDefDir,
      page_objects: poDir,
      support: supportDir,
      page_object_glob: poDir ? `${poDir}/**/*.ts` : 'src/pages/**/*.ts',
    },

    files: {
      hooks: hooksFile,
      world: world.file,
      cucumber_config: cucumberConfig,
      stub_step_def: stubStepDef,
    },

    world: {
      type: world.type,
      import_from_stub: worldImportFromStub,
      has_page_property: world.hasPageProperty,
      has_context_property: world.hasContextProperty,
      has_pages_property: world.hasPagesProperty,
    },

    page_access: pageAccess,

    page_url_expression: pageUrlExpression,

    assertion: {
      expect_import: "const { expect } = require('@playwright/test');",
    },

    // New profile section - contains all available profiles
    profile: {
      all_profiles: profileInfo.all_profiles,
      needs_user_selection: profileInfo.needs_user_selection,
      profiles: allProfileCommands,
    },

    // Backward compatible commands section - uses first profile
    commands: {
      profile_flag: firstProfileCommands.flag,
      base: firstProfileCommands.base_command,
      ...firstProfileCommands.commands,
      tsc_check: discoverTscCommand(),
    },

    conventions: {
      po_suffix: conventions.poSuffix,
      step_def_suffix: conventions.stepDefSuffix,
    },

    cdp_port: 9222,
  };

  return profileObj;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const runDoctor = args.includes('--run-doctor');

  // Parse --profile=<name> parameter
  let userSpecifiedProfile = null;
  const profileArg = args.find(arg => arg.startsWith('--profile='));
  if (profileArg) {
    userSpecifiedProfile = profileArg.split('=')[1];
  }

  const profilePath = path.join(ROOT, '.claude', 'project-profile.json');

  if (fs.existsSync(profilePath) && !force) {
    console.log(`Profile already exists: ${profilePath}`);
    console.log('Use --force to overwrite.');
    process.exit(0);
  }

  const profile = buildProfile(userSpecifiedProfile);

  fs.mkdirSync(path.dirname(profilePath), { recursive: true });
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2) + '\n');
  console.log(`\nProfile written to: ${profilePath}`);

  // Summary
  const warnings = [];
  if (!profile.directories.step_definitions) warnings.push('Could not find step-definition directory');
  if (!profile.directories.page_objects) warnings.push('Could not find page-object directory');
  if (!profile.files.hooks) warnings.push('Could not find hooks file');
  if (!profile.files.world) warnings.push('Could not find world file');
  if (!profile.files.cucumber_config) warnings.push('Could not find cucumber config file');

  if (warnings.length > 0) {
    console.log('\nWarnings:');
    for (const w of warnings) console.log(`  ⚠  ${w}`);
    console.log('\nEdit .claude/project-profile.json manually to fix missing values.');
  } else {
    console.log('\nAll project structure discovered successfully.');
  }

  // ── Next Steps: Configuration Requirements Checklist ───────────────────────
  console.log('\n' + '='.repeat(70));
  console.log('SETUP PHASE 1/2 COMPLETE: Project Profile Generated');
  console.log('='.repeat(70));

  if (runDoctor) {
    console.log('\nRunning PHASE 1: Machine checks (doctor.js)...\n');
    const doctorPath = path.join(__dirname, 'doctor.js');
    try {
      const result = childProcess.spawnSync('node', [doctorPath], {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'inherit',
      });

      console.log('\n' + '='.repeat(70));
      if (result.status !== 0) {
        console.log('⚠ PHASE 1 INCOMPLETE: doctor.js found issues');
        console.log('='.repeat(70));
        console.log('\nRun setup.js to fix auto-fixable issues:');
        console.log('\n  node ' + __filename.replace('discover-project.js', 'setup.js'));
        console.log('\nThen re-run doctor.js to verify:');
        console.log('\n  node ' + __filename.replace('discover-project.js', 'doctor.js'));
      } else {
        console.log('✅ PHASE 1 COMPLETE: Machine checks passed (doctor.js READY)');
        console.log('='.repeat(70));
        console.log('\n⚠️  IMPORTANT: PHASE 2 REQUIRED BEFORE IMPLEMENTATION');
        console.log('─'.repeat(70));
        console.log('\nYou MUST complete PHASE 2: LLM Verification Checklist (5 checks)');
        console.log('\nThis validates semantic correctness that machines cannot check:');
        console.log('  ✓ Check 1: Hooks semantic (BeforeAll/AfterAll, CDP port)');
        console.log('  ✓ Check 2: MCP config semantic (--caps=testing, proxy bypass)');
        console.log('  ✓ Check 3: Project profile consistency');
        console.log('  ✓ Check 4: Edge case scan (CI conditionals, multiple browsers)');
        console.log('  ✓ Check 5: Command template validation (placeholders)');
        console.log('\nSee: references/prerequisites.md → "LLM Verification Checklist"');
        console.log('\nOnly after completing ALL 5 CHECKS should you proceed to Phase 0.');
      }
    } catch (err) {
      console.error('\n❌ Error running doctor.js:', err.message);
      console.log('\nRun manually:');
      console.log('\n  node ' + __filename.replace('discover-project.js', 'doctor.js'));
    }
  } else {
    console.log('\nNEXT STEP: Run Configuration Requirements Checklist');
    console.log('\n  PHASE 1: Machine checks');
    console.log('\n    node ' + __filename.replace('discover-project.js', 'doctor.js'));
    console.log('\n  PHASE 2: LLM Verification (after doctor.js READY)');
    console.log('\n    See: references/prerequisites.md → "LLM Verification Checklist"');
    console.log('\nTip: Use --run-doctor flag to run PHASE 1 automatically:');
    console.log('\n  node "$SKILL_DIR/scripts/discover-project.js" --run-doctor');
  }
  console.log('\n' + '='.repeat(70));
}

main();
