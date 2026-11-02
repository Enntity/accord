// SPDX-License-Identifier: MIT
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
let count = 0;
for (const dir of ['src','src/plugins','vendor/messenger','vendor/lloom','test','test/fixtures','demo','scripts']) {
  for (const file of readdirSync(dir).filter(f => !f.startsWith('.') && /\.(mjs|js)$/.test(f))) {
    const result = spawnSync(process.execPath, ['--check',join(dir,file)], { stdio: 'inherit' });
    if (result.status !== 0) process.exit(result.status || 1); count++;
  }
}
console.log(`Syntax checked ${count} JavaScript modules.`);
