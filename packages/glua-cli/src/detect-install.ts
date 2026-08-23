// Figures out how glua-cli landed on this machine, so an update notice can
// suggest the actual command instead of a generic "go update it".

import fs from 'node:fs';
import path from 'node:path';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface InstallInfo {
  scope: 'workspace' | 'global';
  manager: PackageManager;
  command: string;
}

interface PackageJsonInfo {
  dir: string;
  json: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; packageManager?: string };
}

/**
 * Every `package.json` from `startDir` up to the filesystem root, nearest
 * first — a monorepo commonly declares `glua-cli` (and the lockfile) at the
 * workspace root, not in the leaf package a subcommand happens to run from.
 */
function ancestorPackageJsons(startDir: string): PackageJsonInfo[] {
  const found: PackageJsonInfo[] = [];
  let dir = startDir;
  for (;;) {
    const file = path.join(dir, 'package.json');
    if (fs.existsSync(file)) {
      try {
        found.push({ dir, json: JSON.parse(fs.readFileSync(file, 'utf8')) });
      } catch {
        // Unreadable manifest; keep climbing rather than giving up entirely.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return found;
    dir = parent;
  }
}

/** The `packageManager` field (corepack) wins when present; lockfiles are the fallback. */
function managerFromProject(dir: string, json: PackageJsonInfo['json']): PackageManager | null {
  const name = json.packageManager?.split('@')[0];
  if (name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') return name;

  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
  if (fs.existsSync(path.join(dir, 'bun.lockb')) || fs.existsSync(path.join(dir, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  return null;
}

/** No project to read a lockfile from, so guess from where the running binary itself sits. */
function managerFromInstallPath(): PackageManager {
  const here = __dirname.toLowerCase();
  if (here.includes(`${path.sep}.pnpm${path.sep}`) || here.includes(`${path.sep}pnpm${path.sep}global`)) {
    return 'pnpm';
  }
  if (here.includes(`${path.sep}.bun${path.sep}`)) return 'bun';
  if (here.includes(`${path.sep}yarn${path.sep}`) || here.includes(`${path.sep}.yarn${path.sep}`)) return 'yarn';
  return 'npm';
}

function installCommand(manager: PackageManager, scope: 'workspace' | 'global', dev: boolean): string {
  const pkg = 'glua-cli@latest';

  if (scope === 'global') {
    return {
      npm: `npm install -g ${pkg}`,
      pnpm: `pnpm add -g ${pkg}`,
      yarn: `yarn global add ${pkg}`,
      bun: `bun add -g ${pkg}`,
    }[manager];
  }

  const verb = { npm: 'install', pnpm: 'add', yarn: 'add', bun: 'add' }[manager];
  const devFlag = dev ? { npm: '-D ', pnpm: '-D ', yarn: '-D ', bun: '-d ' }[manager] : '';
  return `${manager} ${verb} ${devFlag}${pkg}`;
}

export function detectInstall(cwd: string = process.cwd()): InstallInfo {
  const ancestors = ancestorPackageJsons(cwd);

  const declaring = ancestors.find(
    (p) => p.json.dependencies?.['glua-cli'] || p.json.devDependencies?.['glua-cli'],
  );
  if (declaring) {
    const dev = Boolean(declaring.json.devDependencies?.['glua-cli']);
    const manager = managerFromProject(declaring.dir, declaring.json) ?? 'npm';
    return { scope: 'workspace', manager, command: installCommand(manager, 'workspace', dev) };
  }

  const nearest = ancestors[0];
  const manager = (nearest && managerFromProject(nearest.dir, nearest.json)) || managerFromInstallPath();
  return { scope: 'global', manager, command: installCommand(manager, 'global', false) };
}
