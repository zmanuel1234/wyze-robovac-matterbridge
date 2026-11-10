// The long-running Python helper (src/pyWorker.ts + py_helpers/wyze_worker.py) against the fake Wyze cloud.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { PyWorker } from '../dist/pyWorker.js';
import { fakeWyze, PYTHON, HELPERS, sleep } from './setup.mjs';

const W = fakeWyze();
const logs = [];
const workers = [];
const NICK = "Robby O'Vac";
function worker(password = 'pw', timeoutMs = 20_000) {
  const w = new PyWorker({ python: PYTHON, script: path.join(HELPERS, 'wyze_worker.py'), secrets: () => W.secrets(password),
    timeoutMs, log: (m) => logs.push(m) });
  workers.push(w);
  return w;
}
after(() => { workers.forEach((w) => w.stop()); W.cleanup(); });

test('status, refused command, unknown command, usage error', async () => {
  const w = worker();
  assert.deepEqual(await w.request('getVacuumStatus', [NICK]), { ok: true, stdout: 'VacuumMode.IDLE:90:True:None:None:None:\n', stderr: '' });
  assert.deepEqual(await w.request('vacuumPauseSweep', [NICK]), { ok: false, stdout: '', stderr: 'RoboVac is docked (not sweeping)....' });
  assert.equal((await w.request('nope', [])).stderr, "Unknown helper command 'nope'");
  assert.match((await w.request('vacuumSetSuction', ['x'])).stderr, /^USAGE: vacuumSetSuction.py/);
  W.set({ suction: 'quiet', battery: 42 });
  assert.equal((await w.request('getVacuumStatus', [NICK])).stdout, 'VacuumMode.IDLE:42:True:None:quiet:None:\n');
  // Wyze's connection state and when it last changed (seconds since the epoch)
  W.set({ online: false, online_since: 1762149619 });
  assert.equal((await w.request('getVacuumStatus', [NICK])).stdout, 'VacuumMode.IDLE:42:True:None:quiet:False:1762149619\n');
  W.set({ online: true });
  assert.match((await w.request('getVacuumStatus', [NICK])).stdout, /:quiet:True:1762149619\n$/);
  W.set({ online: null });   // reported without a value: unknown, treated as online
  assert.match((await w.request('getVacuumStatus', [NICK])).stdout, /:quiet:None:\n$/);
});

test('a warning logged by wyze-sdk does not turn a successful command into a failure', async () => {
  const w = worker();
  W.set({ sdk_warning: true, mode: 'SWEEPING' });
  const status = await w.request('getVacuumStatus', [NICK]);
  W.clearEvents();
  const pause = await w.request('vacuumPauseSweep', [NICK]);
  W.set({ sdk_warning: false, mode: 'IDLE' });
  assert.equal(status.ok, true, status.stderr);
  assert.match(status.stdout, /^VacuumMode.SWEEPING:/);
  assert.equal(pause.ok, true, pause.stderr);
  assert.deepEqual(W.events(), ['pause']);
});

test('rooms are tab-separated, so names may contain ":"', async () => {
  const r = await worker().request('getVacuumFloors', [NICK]);
  assert.deepEqual(r.stdout.trim().split('\n'),
    ['*Entire Floor*\tMain Floor', 'Kitchen\tMain Floor', 'Living Room\tMain Floor', 'Den: East\tMain Floor', '*Entire Floor*\tUp: stairs', 'Bed\tUp: stairs', 'Kitchen\tUp: stairs']);
});

test('requests sent together are all answered, in order', async () => {
  const w = worker();
  const rs = await Promise.all(['getVacuumFloors', 'getVacuumStatus', 'getVacuumDeviceList'].map((c, i) => w.request(c, i === 2 ? [] : [NICK])));
  assert.deepEqual(rs.map((r) => r.ok), [true, true, true]);
  assert.equal(rs[2].stdout.trim(), `${NICK}:JA_RO2_TEST`);
});

test('credentials are not in the worker\'s environment, command line or the log', async () => {
  const w = worker();
  await w.request('getVacuumStatus', [NICK]);
  const pid = w['child'].pid;
  if (fs.existsSync(`/proc/${pid}/environ`)) {
    assert.equal(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').includes('SECRET-API-KEY-123'), false);
    assert.equal(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('SECRET-API-KEY-123'), false);
  }
  assert.equal(logs.some((l) => l.includes('SECRET-API-KEY-123')), false);
});

test('a hung request times out and the next one gets a fresh worker', async () => {
  const w = worker('pw', 3000);
  await w.request('getVacuumStatus', [NICK]);
  const pid = w['child'].pid;
  fs.rmSync(W.tokenFile + '.devices.json', { force: true });   // make the next call list devices (which hangs)
  W.set({ hold: 6 });
  const r = await w.request('getVacuumDeviceList', []);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /No answer from the Wyze helper within 3 s/);
  W.set({ hold: 0 });
  const r2 = await w.request('getVacuumStatus', [NICK]);
  assert.equal(r2.ok, true);
  assert.notEqual(w['child'].pid, pid);
});

test('a crashed worker is started again on the next request', async () => {
  const w = worker();
  await w.request('getVacuumStatus', [NICK]);
  process.kill(w['child'].pid, 'SIGKILL');
  await sleep(300);
  assert.equal((await w.request('getVacuumStatus', [NICK])).ok, true);
});

test('stop() ends the worker; later requests fail cleanly', async () => {
  const w = worker();
  await w.request('getVacuumStatus', [NICK]);
  const child = w['child'];
  w.stop();
  await sleep(1000);
  assert.equal(child.exitCode, 0);
  assert.equal((await w.request('getVacuumStatus', [NICK])).stderr, 'The plugin is shutting down');
});

test('expired token is refreshed once, not a new login', async () => {
  const w = worker();
  await w.request('getVacuumStatus', [NICK]);
  const before = W.read();
  W.set({ valid_access: 'expired-by-test' });
  assert.equal((await w.request('getVacuumStatus', [NICK])).ok, true);
  assert.equal(W.read().logins, before.logins);
  assert.equal(W.read().refreshes, (before.refreshes ?? 0) + 1);
});

test('wrong password: clear error, then no retry for 15 min', async () => {
  fs.rmSync(W.tokenFile, { force: true });
  const w = worker('wrong');
  assert.equal((await w.request('getVacuumStatus', [NICK])).stderr, 'Wyze login failed: The username or password is incorrect.');
  const logins = W.read().logins;
  assert.match((await w.request('getVacuumStatus', [NICK])).stderr, /not retrying for 15 min/);
  assert.equal(W.read().logins, logins);
  w.stop();
  fs.rmSync(W.tokenFile + '.loginfail', { force: true });
  assert.equal((await worker('pw').request('getVacuumStatus', [NICK])).ok, true);
});

test('a failed command with a valid saved vacuum ID is not sent twice', async () => {
  const r = spawnSync(PYTHON, ['-c', `
import sys; sys.path.insert(0, ${JSON.stringify(HELPERS)})
import wyze_auth
from wyze_sdk.errors import WyzeApiError
n = [0]
def body(c):
    n[0] += 1; wyze_auth.find_vacuum_mac(c, "${NICK}"); raise WyzeApiError("device busy", {"code": 3000})
try:
    wyze_auth.run(body)
except SystemExit:
    pass
print(n[0])`], { env: { ...process.env, ...W.secrets() }, encoding: 'utf8' });
  assert.equal(r.stdout.trim(), '1');
  assert.equal(r.stderr.trim(), 'Got an error: device busy');
});

test('a stale saved vacuum ID is looked up again', async () => {
  fs.writeFileSync(W.tokenFile + '.devices.json', JSON.stringify({ [NICK]: 'JA_RO2_OLD' }));
  assert.equal((await worker().request('getVacuumStatus', [NICK])).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(W.tokenFile + '.devices.json', 'utf8'))[NICK], 'JA_RO2_TEST');
});

test('helper scripts still work when run by hand', () => {
  const r = spawnSync(PYTHON, [path.join(HELPERS, 'getVacuumStatus.py'), NICK], { env: { ...process.env, ...W.secrets() }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^VacuumMode\.IDLE:/);
});
