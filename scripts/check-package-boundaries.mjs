import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';

// Layering: core <- packages/* <- apps/*. Packages depend on core only; nothing depends on an app.
const defaultApps = ['@semevolve/cli', '@semevolve/local-ui'];

export function boundaryIssues(dir, manifest, apps = defaultApps) {
  const kind = dir.split('/')[0];
  const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies });
  const issues = [];
  for (const dep of deps.filter(d => d.startsWith('@semevolve/'))) {
    if (apps.includes(dep)) issues.push(`${dir}: depends on app ${dep}`);
    else if (kind === 'packages' && dep !== '@semevolve/core') issues.push(`${dir}: package depends on ${dep}; only @semevolve/core is allowed`);
    else if (manifest.name === '@semevolve/core') issues.push(`${dir}: core must not depend on ${dep}`);
  }
  return issues;
}

export function workspaceBoundaryIssues(path, content) {
  const own = path.split('/').slice(0, 2).join('/');
  const issues = [];
  for (const [, specifier] of content.matchAll(/\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]*)['"]/gu)) {
    const target = posix.join(posix.dirname(path), specifier);
    if (target !== own && !target.startsWith(`${own}/`)) issues.push(`${path}: relative import leaves ${own}`);
  }
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dirs = JSON.parse(readFileSync('package.json', 'utf8')).workspaces;
  const manifests = dirs.map(dir => [dir, JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))]);
  const apps = manifests.filter(([dir]) => dir.startsWith('apps/')).map(([, m]) => m.name);
  const issues = manifests.flatMap(([dir, m]) => boundaryIssues(dir, m, apps));
  const sources = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...dirs], { encoding: 'utf8' })
    .split('\0').filter(p => /\.(?:ts|mjs)$/u.test(p) && !p.includes('/dist/'));
  for (const path of sources) issues.push(...workspaceBoundaryIssues(path, readFileSync(path, 'utf8')));
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Checked ${dirs.length} workspaces and ${sources.length} source files. No boundary violations.\n`);
  }
}
