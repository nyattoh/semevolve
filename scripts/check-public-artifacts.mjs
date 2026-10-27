import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function publicArtifactIssues(path, content) {
  const issues = [];
  const normal = path.replaceAll('\\', '/');
  if (/(^|\/)(runs|logs|node_modules|\.tombo|document-backups)(\/|$)/u.test(normal)
    || /(^|\/)evaluation\/(hidden|answers)(\/|$)/u.test(normal)
    || /(^|\/)\.env(?:\.|$)/u.test(normal)
    || /\.(?:db|sqlite(?:-[\w]+)?|log|pem|key|zip)$/iu.test(normal)) issues.push('private or generated file');
  if (/\b[A-Za-z]:[\\/]/u.test(content) || /\/(?:Users|home)\/[^/\s]+\//u.test(content)) issues.push('local absolute path');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-proj-[A-Za-z0-9_-]{20,})/u.test(content)) issues.push('credential pattern');
  if (/(?:judgment[-]ai[-]starter[-]kit|persona[.]local[.]md)/u.test(content)) issues.push('private judgement reference');
  return issues;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const issues = [];
  for (const path of new Set(paths)) {
    const content = readFileSync(path, 'utf8');
    for (const issue of publicArtifactIssues(path, content)) issues.push(`${path}: ${issue}`);
  }
  if (issues.length) {
    process.stderr.write(`${issues.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`Checked ${new Set(paths).size} public files. No configured patterns found.\n`);
  }
}
