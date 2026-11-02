// The plugin as Home sees it: a real Matter server node (strict validation) with the
// vacuum device, driven through the plugin's command handlers, against the fake Wyze cloud.
import './v4only.cjs';
import '@matter/nodejs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Environment } from '@matter/general';
import { ServerNode } from '@matter/node';
import { DeviceTypeId, VendorId } from '@matter/types/datatype';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import initializePlugin from '../dist/index.js';
import { fakeWyze, PYTHON, sleep } from './setup.mjs';

const W = fakeWyze();
const S = { Running: 1, Paused: 2, Error: 3, SeekingCharger: 64, Charging: 65, Docked: 66 };
const CLEAN = { 1: 'Standard', 3: 'Quiet', 4: 'Strong' };
const RVC_CLEAN_MODE = 0x55;
const SERVICE_AREA = 0x150;
const lines = [];
let server, p, dev, log, cfg;

const op = () => dev.state.rvcOperationalState.operationalState;
const runMode = () => dev.state.rvcRunMode.currentMode;
const areas = () => dev.state.serviceArea.supportedAreas.map((a) => `${a.areaId}:${a.areaInfo.locationInfo.locationName}@${a.mapId}`);
async function poll(state) {   // the vacuum changes; the next status check runs
  if (state) {
    W.set(state);
  }
  await p.getStatus();
}

before(async () => {
  const env = Environment.default;
  env.vars.set('path.root', path.join(W.dir, 'matter'));
  env.vars.set('runtime.signals', false);
  env.vars.set('endpoint.validation', 'strict');
  env.vars.set('log.level', 5);
  server = await ServerNode.create({
    id: 'WyzeTest', environment: env, network: { port: 5540 + Math.floor(Math.random() * 400) },
    productDescription: { name: 'WyzeTest', deviceType: DeviceTypeId(0x0074), vendorId: VendorId(0xfff1), productId: 0x8000 },
    basicInformation: { vendorId: VendorId(0xfff1), vendorName: 'Test', productId: 0x8000, productName: 'WyzeTest', nodeLabel: 'WyzeTest',
      hardwareVersion: 1, softwareVersion: 1 },
  });
  const home = path.join(W.dir, 'home');
  const mb = {
    systemInformation: { interfaceName: 'eth0', macAddress: 'aa:bb:cc:dd:ee:ff', ipv4Address: '', ipv6Address: '', nodeVersion: '22', hostname: 'pi',
      user: 'mb', osType: 'Linux', osRelease: '6', osPlatform: 'linux', osArch: 'arm', totalMemory: '0', freeMemory: '0', constrainedMemory: '0',
      systemUptime: '0', processUptime: '0', cpuUsage: '0', processCpuUsage: '0', rss: '0', heapTotal: '0', heapUsed: '0' },
    uuid: '0', rootDirectory: home, homeDirectory: home, matterbridgeDirectory: path.join(home, '.matterbridge'),
    matterbridgePluginDirectory: path.join(home, 'Matterbridge'), matterbridgeCertDirectory: path.join(home, '.mattercert'),
    globalModulesDirectory: path.join(home, 'node_modules'), matterbridgeVersion: '3.11.1', matterbridgeLatestVersion: '3.11.1',
    matterbridgeDevVersion: '3.11.1', frontendVersion: '3.11.1', bridgeMode: 'bridge', restartMode: 'none', virtualMode: 'disabled',
    aggregatorVendorId: 0xfff1, aggregatorVendorName: 'Matterbridge', aggregatorProductId: 0x8000, aggregatorProductName: 'MB',
  };
  log = new AnsiLogger({ logName: 'WyzeTest', logLevel: LogLevel.DEBUG });
  for (const lvl of ['info', 'debug', 'notice', 'warn', 'error']) {
    log[lvl] = (...a) => { lines.push(`${lvl}: ${a.map(String).join(' ')}`); };
  }
  cfg = { name: 'matterbridge-wyze-robovac', type: 'DynamicPlatform', whiteList: [], blackList: [], enableServerRvc: true,
    username: 'me', password: 'pw', key_id: 'k', api_key: 'a', totpKey: '', busyStatusCheckRefreshInterval: 45,
    idleStatusCheck1RefreshInterval: 300, idleStatusCheck2RefreshInterval: 60, pythonPath: PYTHON, tokenFile: W.tokenFile,
    path2py_stubs: '/nonexistent', debugLevel: 1 };   // old settings: must be ignored
  p = initializePlugin(mb, log, cfg);
  p.registerDevice = async (d) => { dev = d; await server.add(d); };
  p.ready = Promise.resolve();
  p.clearSelect = async () => {};
  p.setSelectDevice = () => {};
  p.validateDevice = () => true;
  p.startStatusLoop = async () => {};   // tests drive status checks themselves
  await p.onStart('test');
});

after(async () => {
  p.stopping = true;
  await p.onShutdown('test end').catch(() => {});
  await server.close().catch(() => {});
  W.cleanup();
});

test('device passes strict Matter validation; rooms and floors from Wyze', () => {
  assert.ok(dev, 'device registered');
  assert.deepEqual(areas(), ['1:*Entire Floor*@1', '2:Kitchen@1', '3:Living Room@1', '4:Den: East@1', '5:*Entire Floor*@2', '6:Bed@2']);
  assert.deepEqual(dev.state.serviceArea.supportedMaps.map((m) => m.name), ['Main Floor', 'Up: stairs']);
  assert.equal(cfg.debugLevel, undefined);
  assert.equal(cfg.path2py_stubs, undefined);
});

test('every Wyze mode maps to the right Home state', async () => {
  p.commandGraceUntil = 0;
  const cases = [
    [{ mode: 'SWEEPING', battery: 80, charging: false }, S.Running, 2, 45],
    [{ mode: 'PAUSE' }, S.Paused, 2, 45],
    [{ mode: 'RETURNING_TO_CHARGE' }, S.SeekingCharger, 1, 45],
    [{ mode: 'DOCKED_NOT_COMPLETE', battery: 30, charging: true }, S.Charging, 2, 60],
    [{ mode: 'IDLE', battery: 55, charging: true }, S.Charging, 1, 60],
    [{ mode: 'IDLE', battery: 100, charging: true }, S.Docked, 1, 300],
    [{ mode: 'CLEANING', battery: 99, charging: false }, S.Running, 2, 45],
  ];
  for (const [state, opState, mode, interval] of cases) {
    await poll(state);
    assert.deepEqual([op(), runMode(), p.statusRefreshInterval], [opState, mode, interval], JSON.stringify(state));
  }
});

test('a Wyze fault shows as a Home error, but not once docked', async () => {
  await poll({ mode: 'SWEEPING', charging: false, fault: 'COLLISION_EXCEPTION' });
  assert.equal(op(), S.Error);
  assert.equal(dev.state.rvcOperationalState.operationalError.errorStateId, 65);   // Stuck
  await poll({ mode: 'IDLE', charging: true });
  assert.notEqual(op(), S.Error);
  await poll({ fault: null });
});

test('start cleaning one room, including a name with ":"', async () => {
  await poll({ mode: 'IDLE', battery: 90, charging: true });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [4] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:1', 'sweep:[13]']);
  assert.deepEqual([op(), runMode()], [S.Running, 2]);
});

test('rooms on two floors: one floor is cleaned and the rest is named in a warning', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [2, 6] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:1', 'sweep:[11]']);
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes("only rooms on 'Main Floor'") && l.endsWith('skipped: Bed')));
});

test('dock: handler returns at once, state is not undone by an early poll', async () => {
  await poll({ mode: 'SWEEPING', charging: false });
  const t0 = Date.now();
  await dev.commandHandler.executeHandler('RvcOperationalState.goHome', { request: {} });
  assert.ok(Date.now() - t0 < 10_000);
  await dev.setAttribute('RvcOperationalState', 'operationalState', S.SeekingCharger, log);   // what Matterbridge does next
  await poll();   // Wyze still says SWEEPING
  assert.equal(op(), S.SeekingCharger);
  p.commandGraceUntil = 0;
  await poll({ mode: 'RETURNING_TO_CHARGE' });
  assert.deepEqual([op(), runMode()], [S.SeekingCharger, 1]);
});

test('run mode Idle while cleaning sends the vacuum to its dock', async () => {
  p.commandGraceUntil = 0;
  await poll({ mode: 'SWEEPING', charging: false });
  W.clearEvents();
  await dev.commandHandler.executeHandler('RvcRunMode.changeToMode', { request: { newMode: 1 } });
  assert.deepEqual(W.events(), ['dock']);
});

test('a refused command has the real state shown at the next check', async () => {
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', charging: true });
  await dev.commandHandler.executeHandler('RvcOperationalState.pause', { request: {} });   // Wyze: "docked"
  assert.deepEqual([p.commandGraceUntil, p.pokeStatusLoop, p.lastAppliedState], [0, true, '']);
  await dev.setAttribute('RvcOperationalState', 'operationalState', S.Paused, log);       // what Matterbridge does next
  await poll();
  assert.equal(op(), S.Charging);
});

test('a missing battery reading keeps the last value', async () => {
  await poll({ battery: 70 });
  await poll({ battery: null });
  assert.equal(dev.state.powerSource.batPercentRemaining, 140);
});

test('overlapping status checks share one Wyze request', async () => {
  let runs = 0;
  const orig = p.py.bind(p);
  p.py = async (s, a) => { if (s === 'getVacuumStatus.py') { runs++; } return orig(s, a); };
  await Promise.all([p.getStatus(), p.getStatus(), p.getStatus()]);
  p.py = orig;
  assert.equal(runs, 1);
});

test('low-battery warning only away from the dock', async () => {
  p.commandGraceUntil = 0;
  const level = { 0: 'OK', 1: 'Warning', 2: 'Critical' };
  for (const [battery, charging, expected] of [[50, false, 'OK'], [20, false, 'Warning'], [10, false, 'Critical'], [5, true, 'OK']]) {
    await poll({ mode: charging ? 'IDLE' : 'SWEEPING', battery, charging });
    assert.equal(level[dev.state.powerSource.batChargeLevel], expected, `${battery}% ${charging ? 'docked' : 'away'}`);
  }
  await poll({ mode: 'SWEEPING', battery: 100, charging: false });
  assert.notEqual(dev.state.powerSource.batChargeState, 2);   // "full" only on the dock
});

test('suction level follows the Wyze app; Home choices survive a lagging poll', async () => {
  p.commandGraceUntil = 0;
  const mode = () => CLEAN[dev.state.rvcCleanMode.currentMode];
  await poll({ mode: 'IDLE', battery: 90, charging: true, suction: 'quiet' });
  assert.equal(mode(), 'Quiet');
  await poll({ suction: 'strong' });
  assert.equal(mode(), 'Strong');
  await poll({ suction: null });
  assert.equal(mode(), 'Strong');
  W.clearEvents();
  await dev.commandHandler.executeHandler('RvcCleanMode.changeToMode', { request: { newMode: 1 } });
  assert.deepEqual(W.events(), ['suction:STANDARD']);
  await dev.updateAttribute(RVC_CLEAN_MODE, 'currentMode', 1, log);
  W.set({ suction: 'strong' });   // Wyze lags
  await poll();
  assert.equal(mode(), 'Standard');
  p.suctionGraceUntil = 0;
  await poll({ suction: 'standard' });
  assert.equal(mode(), 'Standard');
});

test('room list refresh keeps IDs, adds new rooms, drops vanished ones from the selection', async () => {
  W.set({ maps: [{ name: 'Main Floor', rooms: ['Cook Room', 'Living Room', 'Pantry'] }, { name: 'Up: stairs', rooms: ['Bed'] }] });
  p.selectedAreas = [3, 4];
  await dev.updateAttribute(SERVICE_AREA, 'selectedAreas', [3, 4], log);
  await p.refreshRooms();
  assert.deepEqual(areas(), ['1:*Entire Floor*@1', '7:Cook Room@1', '3:Living Room@1', '8:Pantry@1', '5:*Entire Floor*@2', '6:Bed@2']);
  assert.deepEqual([...dev.state.serviceArea.selectedAreas], [3]);
  const n = lines.length;
  await p.refreshRooms();
  assert.equal(lines.slice(n).some((l) => l.includes('room list changed')), false);
});

test('status loop: refreshes rooms only when docked and due, and stops on shutdown', async () => {
  let refreshes = 0;
  const orig = p.refreshRooms.bind(p);
  p.refreshRooms = async () => { refreshes++; };
  delete p.startStatusLoop;
  const run = async (mode, charging, hoursAgo) => {
    W.set({ mode, charging, fault: null });
    Object.assign(p, { lastRoomRefresh: Date.now() - hoursAgo * 3600e3, commandGraceUntil: 0, lastAppliedState: '', stopping: false });
    refreshes = 0;
    const loop = p.startStatusLoop();
    await sleep(1500);
    p.stopping = true;
    p.pokeStatusLoop = true;
    await Promise.race([loop, sleep(15_000).then(() => { throw new Error('loop did not stop'); })]);
    return refreshes;
  };
  assert.equal(await run('IDLE', true, 7), 1);
  assert.equal(await run('IDLE', true, 1), 0);
  assert.equal(await run('SWEEPING', false, 7), 0);
  p.refreshRooms = orig;
});

test('no errors logged', () => {
  assert.deepEqual(lines.filter((l) => l.startsWith('error:')), []);
});
