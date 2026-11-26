// Scaffold the VibeMission directory layout:
//   <root>/shared/ledger      task ledger (SQLite, created on first run)
//   <root>/shared/tasks       task artifacts, evidence, handoff notes
//   <root>/offices/<product>/{inbox,reports}
// Idempotent: existing files are never overwritten.

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const out = { root: null, products: ['zcode'], dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i];
    else if (a === '--products') out.products = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const README = `# VibeMission 顶层目录

> 办公室各归各，任务放在共享层。

\`\`\`
shared/
├── ledger/tasks.sqlite   任务账本（唯一真相）
└── tasks/                任务过程稿、证据、跨产品交接
offices/
└── <product>/            inbox / reports（该产品独占写）
\`\`\`

三条规矩：

1. offices/<product>/ 只有该产品能写；
2. shared/ledger/ 只由接口人经 MCP 写；
3. 办公室不放任务状态，状态只进账本。
`;

function plan(root, products) {
  const dirs = [
    join(root, 'shared', 'ledger'),
    join(root, 'shared', 'tasks'),
    ...products.flatMap((p) => [join(root, 'offices', p, 'inbox'), join(root, 'offices', p, 'reports')]),
  ];
  return { dirs, readme: join(root, 'README.md') };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.root) {
    console.log('usage: node scripts/init-layout.mjs --root <dir> [--products zcode,workbuddy] [--dry-run]');
    process.exit(opts.help ? 0 : 2);
  }
  const root = resolve(opts.root);
  const products = opts.products.length ? opts.products : ['zcode'];
  const { dirs, readme } = plan(root, products);

  console.log(`root: ${root}`);
  console.log(`products: ${products.join(', ')}`);
  for (const d of dirs) {
    if (opts.dryRun) console.log(`  [dry-run] mkdir ${d}`);
    else {
      mkdirSync(d, { recursive: true });
      console.log(`  ok ${d}`);
    }
  }
  if (existsSync(readme)) {
    console.log(`  skip ${readme} (exists)`);
  } else if (opts.dryRun) {
    console.log(`  [dry-run] write ${readme}`);
  } else {
    writeFileSync(readme, README, 'utf8');
    console.log(`  ok ${readme}`);
  }

  console.log('\nnext:');
  console.log(`  1) 账本路径指到 ${join(root, 'shared', 'ledger', 'tasks.sqlite')}（~/.agents/mcp.json 的 TASKPIER_DB_PATH）`);
  console.log('  2) 插件市场添加 <repo>/adapters/zcode 并重启');
  console.log('  3) node scripts/install-skill.mjs  让接口人技能生效');
  console.log('  4) node scripts/project-index.mjs --resolve "<一句话>" 验证路由');
}

main();
