#!/usr/bin/env node
'use strict';

/**
 * resolve-skill-path.js
 *
 * Resolves the absolute path to the bdd-step-implementor skill directory,
 * regardless of where it's installed.
 *
 * Usage:
 *   SKILL_DIR=$(node <path-to-this-script>)
 *   node "$SKILL_DIR/scripts/discover-project.js"
 *
 * The script searches in this order:
 * 1. Same directory as this script (fastest - script is inside the skill)
 * 2. Project-local: .claude/skills/bdd-step-implementor/
 * 3. Global user: ~/.claude/skills/bdd-step-implementor/
 * 4. Global system (Windows): %ProgramData%/Claude/skills/bdd-step-implementor/
 * 5. Plugin directories (various possible locations)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function findSkillDir() {
  const skillName = 'bdd-step-implementor';
  const searchPaths = [];

  // 1. Development mode / Direct invocation (script is already inside the skill)
  const scriptDir = path.dirname(__filename);
  const devPath = path.dirname(scriptDir); // parent of scripts/
  if (fs.existsSync(path.join(devPath, 'SKILL.md'))) {
    return devPath;
  }
  searchPaths.push(['Dev/Direct', devPath]);

  // 2. Project-local installation
  const projectLocal = path.join(process.cwd(), '.claude', 'skills', skillName);
  if (fs.existsSync(path.join(projectLocal, 'SKILL.md'))) {
    return projectLocal;
  }
  searchPaths.push(['Project-local', projectLocal]);

  // 3. Global user installation
  const globalUser = path.join(os.homedir(), '.claude', 'skills', skillName);
  if (fs.existsSync(path.join(globalUser, 'SKILL.md'))) {
    return globalUser;
  }
  searchPaths.push(['Global user', globalUser]);

  // 4. Global system installation (Windows)
  if (process.platform === 'win32') {
    const programData = process.env.PROGRAMDATA || 'C:\\ProgramData';
    const globalSystem = path.join(programData, 'Claude', 'skills', skillName);
    if (fs.existsSync(path.join(globalSystem, 'SKILL.md'))) {
      return globalSystem;
    }
    searchPaths.push(['Global system', globalSystem]);
  }

  // 5. Plugin directories (common locations)
  const pluginDirs = [
    // Claude Code installation directory
    process.env.CLAUDE_CODE_HOME && path.join(process.env.CLAUDE_CODE_HOME, 'plugins', skillName),
    // VS Code extension data
    os.homedir() && path.join(os.homedir(), '.vscode', 'extensions', 'anthropic.claude-code-*', 'skills', skillName),
    // Common plugin directories
    path.join(os.homedir(), '.claude', 'plugins', skillName),
    path.join(os.homedir(), 'AppData', 'Local', 'Claude', 'plugins', skillName),
    path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'plugins', skillName),
  ].filter(Boolean);

  for (const pluginDir of pluginDirs) {
    if (fs.existsSync(path.join(pluginDir, 'SKILL.md'))) {
      return pluginDir;
    }
    searchPaths.push(['Plugin', pluginDir]);
  }

  // Not found - report all searched locations
  console.error('Error: bdd-step-implementor skill not found');
  console.error('Searched locations:');
  for (const [label, loc] of searchPaths) {
    console.error(`  - ${label}: ${loc}`);
  }
  process.exit(1);
}

const skillDir = findSkillDir();
console.log(skillDir);
