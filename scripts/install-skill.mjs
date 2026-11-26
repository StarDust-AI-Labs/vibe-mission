// Keep the running copy of the owner skill in sync with the repo.
// The ZCode plugin (loaded via plugins.dirs) contributes MCP + hooks but not skills,
// so the skill must live under a user-level discovery root: ~/.agents/skills.

import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'adapters', 'zcode', 'vibemission', 'skills', 'vibemission-owner', 'SKILL.md');
const DEST_DIR = join(homedir(), '.agents', 'skills', 'vibemission-owner');
const DEST = join(DEST_DIR, 'SKILL.md');

const check = process.argv.includes('--check');

if (!existsSync(SRC)) {
  console.error(`source missing: ${SRC}`);
  process.exit(1);
}

if (check) {
  if (!existsSync(DEST)) {
    console.log('NOT INSTALLED');
    process.exit(2);
  }
  const same = readFileSync(SRC, 'utf8') === readFileSync(DEST, 'utf8');
  console.log(same ? 'IN SYNC' : 'OUT OF SYNC (run without --check to update)');
  process.exit(same ? 0 : 3);
}

mkdirSync(DEST_DIR, { recursive: true });
copyFileSync(SRC, DEST);
console.log(`installed: ${DEST}`);
console.log('restart the host or start a new session so the skill is picked up.');
