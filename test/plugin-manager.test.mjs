// Packs the plugin exactly as it is installed on the Pi and has Matterbridge's own plugin
// manager add it. This is the check that would have caught 1.0.5/1.0.6, which Matterbridge
// refused to load ("Found matterbridge package in the plugin devDependencies").
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ROOT } from './setup.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wyze-pack-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const npm = (args, env = {}) => execFileSync('npm', args, { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

test('the package has the right files and nothing else', () => {
  npm(['pack', '--ignore-scripts', '--pack-destination', tmp]);   // dist/ is built by `npm test` first
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, 'npm pack made a .tgz');
  const files = execFileSync('tar', ['tzf', path.join(tmp, tgz)], { encoding: 'utf8' }).trim().split('\n').map((f) => f.replace(/^package\//, '')).sort();
  for (const f of ['dist/index.js', 'dist/platform.js', 'dist/pyWorker.js', 'py_helpers/wyze_auth.py', 'py_helpers/wyze_worker.py',
    'matterbridge-wyze-robovac.schema.json', 'package.json', 'README.md', 'LICENSE']) {
    assert.ok(files.includes(f), `${f} is in the package`);
  }
  assert.deepEqual(files.filter((f) => /^(test|src|node_modules)\/|\.ts$|tsbuildinfo|__pycache__|\.pyc$/.test(f)), [], 'no sources, tests or build leftovers');
});

test('Matterbridge\'s plugin manager accepts and adds the packed plugin', () => {
  const tgz = path.join(tmp, fs.readdirSync(tmp).find((f) => f.endsWith('.tgz')));
  const prefix = path.join(tmp, 'prefix');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  npm(['install', '--global', '--omit=dev', '--no-fund', '--no-audit', tgz], { NPM_CONFIG_PREFIX: prefix });
  const out = execFileSync(path.join(ROOT, 'node_modules', '.bin', 'matterbridge'), ['-add', 'matterbridge-wyze-robovac', '-homedir', home],
    { encoding: 'utf8', env: { ...process.env, HOME: home, NPM_CONFIG_PREFIX: prefix }, timeout: 60_000 }).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.match(out, /Added plugin matterbridge-wyze-robovac/, out.split('\n').filter((l) => /PluginManager/.test(l)).join('\n'));
});
