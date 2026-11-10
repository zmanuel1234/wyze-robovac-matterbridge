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

// Short waits for the floor-switch retry in vacuumStartSweep.py.
process.env.WYZE_MAP_SWITCH_POLL = '0.2';
process.env.WYZE_MAP_SWITCH_WAIT = '2';

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
  cfg = { name: 'matterbridge-wyze-robovac-plus', type: 'DynamicPlatform', whiteList: [], blackList: [], enableServerRvc: true,
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
  assert.deepEqual(areas(), ['1:Kitchen@1', '2:Living Room@1', '3:Den: East@1', '4:Bed@2', '5:Kitchen@2']);   // no "*Entire Floor*" 
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
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [3] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:1', 'sweep:[13]']);
  assert.deepEqual([op(), runMode()], [S.Running, 2]);
});

test('rooms on two floors: one floor is cleaned and the rest is named in a warning', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [1, 4] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:1', 'sweep:[11]']);
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes("only rooms on 'Main Floor'") && l.endsWith('skipped: Bed')));
});

test('a room on another floor: switches the floor, then sweeps that floor\'s room', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.set({ current_map: 0 });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [4] } });   // Bed, upstairs
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[21]']);
});

test('Wyze reporting the old floor for a moment after the switch: waits, then sweeps the right room', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.set({ current_map: 0, map_lag: 2 });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [4] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[21]']);
});

test('rooms that never show up on the current map: nothing is started, Home shows the real state', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.set({ current_map: 0, map_lag: 1000 });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [4] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:2']);
  assert.ok(lines.some((l) => l.includes('not on the vacuum\'s current map')), 'the log says why');
  assert.equal(p.pokeStatusLoop, true);
  W.set({ map_lag: 0 });
});

// Run modes for Alexa, which has no room list: one per floor and per room.
const modes = () => dev.state.rvcRunMode.supportedModes.map((m) => `${m.mode}:${m.label}`);
const RUN = { dock: 1, clean: 2, mainAll: 10, kitchen: 11, living: 12, den: 13, upAll: 14, bed: 15, upKitchen: 16 };
async function runModeCommand(newMode, currentMode = 1) {   // as Matterbridge calls it
  W.clearEvents();
  await dev.commandHandler.executeHandler('RvcRunMode.changeToMode', { request: { newMode }, attributes: { currentMode } });
}
async function sweptOrIdle() {   // the handler starts in the background: wait for the sweep
  for (let i = 0; i < 100 && !W.events().some((e) => e.startsWith('sweep')); i++) {
    await sleep(100);
  }
  await sleep(300);
}

test('run modes: Dock, Clean, then Clean All and Clean <room> per floor, numbers saved', () => {
  assert.deepEqual(modes(), ['1:Dock', '2:Clean', '10:Clean All (Main Floor)', '11:Clean Kitchen (Main Floor)',
    '12:Clean Living Room', '13:Clean Den: East', '14:Clean All (Up: stairs)', '15:Clean Bed', '16:Clean Kitchen (Up: stairs)']);
  const tags = dev.state.rvcRunMode.supportedModes.map((m) => m.modeTags.map((t) => t.value).join());
  assert.deepEqual(tags, ['16384', ...Array(8).fill('16385')]);   // Idle, then Cleaning
  const saved = JSON.parse(fs.readFileSync(path.join(path.dirname(W.tokenFile), 'run-modes.json'), 'utf8')).modes;
  assert.equal(saved['Up: stairs\tBed'], RUN.bed);
  assert.equal(saved['Main Floor\t*Entire Floor*'], RUN.mainAll);
});

test('run modes: a room keeps its number when rooms are added or reordered', () => {
  const [rooms, areaIds] = [p.rooms, new Map(p.areaIds)];
  p.rooms = ['*Entire Floor*\tMain Floor', 'Hall\tMain Floor', 'Den: East\tMain Floor', 'Kitchen\tMain Floor',
    '*Entire Floor*\tUp: stairs', 'Bed\tUp: stairs'];
  p.setupSupportedAreas();
  const m = Object.fromEntries(p.buildRunModes().map((x) => [x.label, x.mode]));
  assert.deepEqual([m['Clean Kitchen'], m['Clean Den: East'], m['Clean Bed'], m['Clean Hall']], [RUN.kitchen, RUN.den, RUN.bed, 17]);
  p.rooms = ['*Entire Floor*\tMain Floor', 'Bath\tMain Floor', 'Bath\tMain Floor', 'All\tMain Floor'];   // duplicates
  p.setupSupportedAreas();
  assert.deepEqual(p.buildRunModes().map((x) => x.label), ['Dock', 'Clean', 'Clean All', 'Clean Bath']);
  p.rooms = rooms;   // back to the device's list and area IDs
  p.areaIds.clear();
  areaIds.forEach((v, k) => p.areaIds.set(k, v));
  p.setupSupportedAreas();
  p.buildRunModes();
});

test('run mode "Clean <room>" from the dock: switches floor, sweeps that room, shows the mode while cleaning', async () => {
  Object.assign(p, { commandGraceUntil: 0 });
  await poll({ mode: 'IDLE', battery: 90, charging: true, current_map: 1 });
  await runModeCommand(RUN.bed);
  await sweptOrIdle();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[21]']);
  assert.deepEqual([op(), runMode()], [S.Running, RUN.bed]);
  p.commandGraceUntil = 0;
  await poll({ mode: 'SWEEPING', charging: false });
  assert.equal(runMode(), RUN.bed, 'still shows "Clean Bed"');
  await poll({ mode: 'RETURNING_TO_CHARGE' });
  assert.equal(runMode(), RUN.dock);
  await poll({ mode: 'SWEEPING' });   // a run started in the Wyze app
  assert.equal(runMode(), RUN.clean);
  await poll({ mode: 'IDLE', charging: true });
});

test('run mode "Clean All" cleans that whole floor; the room with a shared name has its own mode', async () => {
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', charging: true, current_map: 0 });
  await runModeCommand(RUN.upAll);
  await sweptOrIdle();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[]']);
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', charging: true, current_map: 0 });
  await runModeCommand(RUN.upKitchen);
  await sweptOrIdle();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[22]']);
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', charging: true, current_map: 0 });
});

test('run modes: another cleaning mode while busy is not started', async () => {
  await runModeCommand(RUN.kitchen, RUN.bed);
  await runModeCommand(RUN.clean, RUN.den);
  await runModeCommand(RUN.den, RUN.clean);
  await sleep(500);
  assert.deepEqual(W.events(), []);
  assert.ok(lines.some((l) => l.includes("'Clean Kitchen (Main Floor)' not started: the vacuum is busy with 'Clean Bed'")));
});

test('"Clean" uses the rooms picked in Home; all of a floor\'s rooms, or none, clean the whole floor', async () => {
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', charging: true, current_map: 0 });
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [1, 2, 3] } });
  await p.doSweeping();
  assert.deepEqual(W.events().slice(-1), ['sweep:[]']);
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', charging: true, current_map: 0 });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:1', 'sweep:[]']);
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', charging: true });
});

test('a clean-mode change never reaches the run-mode handler', async () => {
  W.clearEvents();
  await dev.commandHandler.executeHandler('RvcCleanMode.changeToMode', { request: { newMode: 3 } });   // Quiet
  assert.deepEqual(W.events().map((e) => e.split(':')[0]), ['suction']);
  p.suctionGraceUntil = 0;
});

test('intervals: documented limits apply to hand-edited settings', () => {
  const saved = { ...p.config };
  Object.assign(p.config, { busyStatusCheckRefreshInterval: 5, idleStatusCheck1RefreshInterval: 99999, idleStatusCheck2RefreshInterval: 'x' });
  assert.deepEqual([p.interval('busyStatusCheckRefreshInterval'), p.interval('idleStatusCheck1RefreshInterval'),
    p.interval('idleStatusCheck2RefreshInterval')], [25, 3600, 60]);
  Object.assign(p.config, saved);
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

test('offline: Home shows an error instead of the stale state, warned once, slow checks', async () => {
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', battery: 40, charging: true, online: true });
  assert.equal(op(), S.Charging);
  const before = lines.length;
  // What Wyze reported on the Pi: the last state before it went (paused, 12%), plus offline.
  await poll({ mode: 'PAUSE', battery: 12, charging: false, online: false, online_since: 1762149619 });
  await poll();
  assert.equal(op(), S.Error);
  assert.equal(dev.state.rvcOperationalState.operationalError.errorStateId, 1);   // UnableToStartOrResume
  assert.equal(dev.state.rvcOperationalState.operationalError.errorStateDetails, 'Vacuum is offline');
  assert.equal(dev.state.powerSource.batPercentRemaining, 80);   // stale 12% not shown
  assert.equal(p.statusRefreshInterval, 300);
  const warned = lines.slice(before).filter((l) => l.includes('Vacuum is offline since'));
  assert.equal(warned.length, 1);
});

test('offline: commands from Home are not sent, and the error comes back', async () => {
  W.clearEvents();
  await dev.commandHandler.executeHandler('RvcOperationalState.pause', { request: {} });
  await dev.commandHandler.executeHandler('RvcOperationalState.goHome', { request: {} });
  await dev.commandHandler.executeHandler('RvcCleanMode.changeToMode', { request: { newMode: 4 } });
  await p.doSweeping();   // what start/resume runs in the background
  assert.deepEqual(W.events(), []);
  assert.equal(p.pokeStatusLoop, true);
  await dev.setAttribute('RvcOperationalState', 'operationalState', S.Running, log);   // what Matterbridge does next
  await poll();
  assert.equal(op(), S.Error);
});

test('offline: back online shows the real state at once and resumes normal checks', async () => {
  const before = lines.length;
  await poll({ mode: 'IDLE', battery: 5, charging: true, online: true, online_since: 1762149900 });
  assert.equal(op(), S.Charging);
  assert.equal(dev.state.rvcOperationalState.operationalError.errorStateId, 0);
  assert.equal(dev.state.powerSource.batPercentRemaining, 10);
  assert.equal(p.statusRefreshInterval, 60);
  assert.ok(lines.slice(before).some((l) => l.includes('Vacuum is back online')));
  // A command that finds it offline checks again first: back online, so it is sent.
  p.offline = true;
  W.clearEvents();
  await dev.commandHandler.executeHandler('RvcCleanMode.changeToMode', { request: { newMode: 3 } });
  assert.deepEqual(W.events().map((e) => e.split(':')[0]), ['suction']);
  assert.equal(p.offline, false);
});

test('room list refresh keeps IDs, adds new rooms, drops vanished ones from the selection', async () => {
  W.set({ maps: [{ name: 'Main Floor', rooms: ['Cook Room', 'Living Room', 'Pantry'] }, { name: 'Up: stairs', rooms: ['Bed'] }] });
  p.selectedAreas = [2, 3];
  await dev.updateAttribute(SERVICE_AREA, 'selectedAreas', [2, 3], log);
  await p.refreshRooms();
  assert.deepEqual(areas(), ['6:Cook Room@1', '2:Living Room@1', '7:Pantry@1', '4:Bed@2']);
  assert.deepEqual([...dev.state.serviceArea.selectedAreas], [2]);
  assert.ok(lines.some((l) => l.includes('reaches the run modes')), 'says Alexa\'s list updates at restart');
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
