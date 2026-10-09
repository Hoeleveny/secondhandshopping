/* ==========================================================================
   前端静态自检：ES 模块的 import 路径与具名导出是否对得上
   浏览器里模块加载失败往往只报一句 "Failed to fetch dynamically imported module"，
   这个脚本能在不打开浏览器的情况下把这类错误提前找出来。

   用法： node tools/check_frontend.mjs [static/js 目录]
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || 'static/js');
const problems = [];
const files = [];

(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(ROOT);

function exportedNames(file) {
  const source = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1]);
  for (const m of source.matchAll(/export\s*\{([^}]+)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) names.add(name);
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

const exportCache = new Map();
function exportsFor(file) {
  if (!exportCache.has(file)) exportCache.set(file, exportedNames(file));
  return exportCache.get(file);
}

function resolve(specifier, fromFile) {
  const target = path.resolve(path.dirname(fromFile), specifier);
  if (fs.existsSync(target) && fs.statSync(target).isFile()) return target;
  if (fs.existsSync(`${target}.js`)) return `${target}.js`;
  return null;
}

function checkSpecifier(specifier, fromFile, names, kind) {
  if (!specifier.startsWith('.')) return;   // 只检查相对路径
  const target = resolve(specifier, fromFile);
  const rel = path.relative(process.cwd(), fromFile);
  if (!target) {
    problems.push(`${rel}：找不到 ${kind} 目标 ${specifier}`);
    return;
  }
  if (!names.length) return;
  const available = exportsFor(target);
  names.forEach((name) => {
    if (!available.has(name)) {
      problems.push(`${rel}：从 ${specifier} 导入了不存在的 ${name}`);
    }
  });
}

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');

  // import Default, { a, b } from './x.js'
  const staticRe = /import\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of source.matchAll(staticRe)) {
    const clause = m[1];
    const specifier = m[2];
    const names = [];
    const named = clause.match(/\{([^}]*)\}/);
    if (named) {
      named[1].split(',').forEach((part) => {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.push(name);
      });
    }
    const beforeBrace = clause.split('{')[0].replace(/,\s*$/, '').trim();
    if (beforeBrace && !beforeBrace.startsWith('*')) names.push('default');
    checkSpecifier(specifier, file, names, '静态 import');
  }

  // import('./x.js')
  const dynamicRe = /import\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const m of source.matchAll(dynamicRe)) {
    checkSpecifier(m[1], file, [], '动态 import');
  }
}

console.log(`扫描 ${files.length} 个前端模块`);
if (problems.length) {
  console.log(`\n发现 ${problems.length} 个问题：`);
  problems.forEach(p => console.log(`  ✗ ${p}`));
  process.exit(1);
}
console.log('✅ import 路径与具名导出全部正常');
