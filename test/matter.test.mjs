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
  // No "*Entire Floor*" in the list, but IDs as before it was hidden (1 and 5 were the floors).
  assert.deepEqual(areas(), ['2:Kitchen@1', '3:Living Room@1', '4:Den: East@1', '6:Bed@2', '7:Kitchen@2']);
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

test('a room on another floor: switches the floor, then sweeps that floor\'s room', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.set({ current_map: 0 });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [6] } });   // Bed, upstairs
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[21]']);
});

test('Wyze reporting the old floor for a moment after the switch: waits, then sweeps the right room', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.set({ current_map: 0, map_lag: 2 });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [6] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[21]']);
});

test('rooms that never show up on the current map: nothing is started, Home shows the real state', async () => {
  await poll({ mode: 'IDLE', charging: true });
  W.set({ current_map: 0, map_lag: 1000 });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [6] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:2']);
  assert.ok(lines.some((l) => l.includes('not on the vacuum\'s current map')), 'the log says why');
  assert.equal(p.pokeStatusLoop, true);
  W.set({ map_lag: 0 });
});

// Run modes for Alexa, which has no room list: one per floor and per room. Commands go
// through Matterbridge's own run-mode server, as a controller's would.
const modes = () => dev.state.rvcRunMode.supportedModes.map((m) => `${m.mode}:${m.label}`);
const RUN = { dock: 1, clean: 2, mainAll: 10, kitchen: 11, living: 12, den: 13, upAll: 14, bed: 15, upKitchen: 16 };
const runModeFile = () => path.join(path.dirname(W.tokenFile), 'run-modes.json');
const savedModes = () => JSON.parse(fs.readFileSync(runModeFile(), 'utf8'));
async function runModeCommand(newMode) {
  W.clearEvents();
  await dev.invokeBehaviorCommand('rvcRunMode', 'changeToMode', { newMode });
}
async function waitForEvent(prefix) {   // starts run in the background: wait for the Wyze call
  for (let i = 0; i < 100 && !W.events().some((e) => e.startsWith(prefix)); i++) {
    await sleep(100);
  }
  await sleep(300);
}
async function docked() {
  p.commandGraceUntil = 0;
  await poll({ mode: 'IDLE', battery: 90, charging: true, current_map: 0, fault: null });
  assert.equal(runMode(), RUN.dock);
}

test('run modes: Dock, Clean, then Clean All and Clean <room> per floor, numbers saved', () => {
  assert.deepEqual(modes(), ['1:Dock', '2:Clean', '10:Clean All (Main Floor)', '11:Clean Kitchen (Main Floor)',
    '12:Clean Living Room', '13:Clean Den: East', '14:Clean All (Up: stairs)', '15:Clean Bed', '16:Clean Kitchen (Up: stairs)']);
  const tags = dev.state.rvcRunMode.supportedModes.map((m) => m.modeTags.map((t) => t.value).join());
  assert.deepEqual(tags, ['16384', ...Array(8).fill('16385')]);   // Idle, then Cleaning
  const saved = savedModes();
  assert.deepEqual(saved.modes['Up: stairs\tBed'], { mode: RUN.bed, label: 'Clean Bed' });
  assert.equal(saved.modes['Main Floor\t*Entire Floor*'].mode, RUN.mainAll);
});

test('run modes: numbers kept when rooms are added; gone rooms dropped; duplicates offered once', () => {
  const backup = { rooms: p.rooms, areaIds: new Map(p.areaIds), file: fs.readFileSync(runModeFile(), 'utf8'), shown: p.lastShownMode };
  const build = (rooms) => {
    p.rooms = rooms;
    p.setupSupportedAreas();
    return Object.fromEntries(p.buildRunModes().map((x) => [x.label, x.mode]));
  };
  let m = build(['*Entire Floor*\tMain Floor', 'Hall\tMain Floor', 'Den: East\tMain Floor', 'Kitchen\tMain Floor',
    '*Entire Floor*\tUp: stairs', 'Bed\tUp: stairs']);
  assert.deepEqual([m['Clean Kitchen'], m['Clean Den: East'], m['Clean Bed'], m['Clean Hall']], [RUN.kitchen, RUN.den, RUN.bed, 17]);
  assert.equal(savedModes().modes['Main Floor\tLiving Room'], undefined, 'a room gone from Wyze frees its number');
  m = build(['*Entire Floor*\tMain Floor', 'Bath\tMain Floor', 'Bath\tMain Floor', 'All\tMain Floor']);
  assert.deepEqual(Object.keys(m), ['Dock', 'Clean', 'Clean All', 'Clean Bath', 'Clean All (2)']);   // one Bath; "All" kept apart
  assert.equal(p.supportedAreas.length, 2, 'the two Baths are one area');
  assert.equal(p.constructor.modeText('Clean ' + 'é'.repeat(40)).length, 35, '64 bytes of UTF-8 (6 + 29 two-byte characters), whole characters');
  fs.writeFileSync(runModeFile(), backup.file);   // back to the device's list
  p.lastShownMode = backup.shown;
  p.areaIds.clear();
  backup.areaIds.forEach((v, k) => p.areaIds.set(k, v));
  build(backup.rooms);
  assert.deepEqual(savedModes().modes['Up: stairs\tBed'].mode, RUN.bed);
});

test('run modes: a corrupt run-modes.json is renumbered with a warning', () => {
  const file = fs.readFileSync(runModeFile(), 'utf8');
  fs.writeFileSync(runModeFile(), '{ not json');
  const n = lines.length;
  assert.deepEqual(p.readRunModeFile().modes, {});
  assert.ok(lines.slice(n).some((l) => l.startsWith('warn:') && l.includes('may need to be set up again')));
  fs.writeFileSync(runModeFile(), file);
});

test('run mode "Clean <room>" from the dock: switches floor, sweeps that room, shows the mode while cleaning', async () => {
  await docked();
  await runModeCommand(RUN.bed);
  await waitForEvent('sweep');
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[21]']);
  assert.deepEqual([op(), runMode()], [S.Running, RUN.bed]);
  assert.equal(savedModes().lastShown, RUN.bed, 'remembered for the next start');
  p.commandGraceUntil = 0;
  await poll({ mode: 'SWEEPING', charging: false });
  assert.equal(runMode(), RUN.bed, 'still shows "Clean Bed"');
  await poll({ mode: 'RETURNING_TO_CHARGE' });
  assert.equal(runMode(), RUN.dock);
  assert.equal(savedModes().lastShown, RUN.dock);
  await poll({ mode: 'SWEEPING' });   // a run started in the Wyze app
  assert.equal(runMode(), RUN.clean);
  await docked();
});

test('run mode "Clean All" cleans that whole floor; the room with a shared name has its own mode', async () => {
  await docked();
  await runModeCommand(RUN.upAll);
  await waitForEvent('sweep');
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[]']);
  await docked();
  await runModeCommand(RUN.upKitchen);
  await waitForEvent('sweep');
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[22]']);
  await docked();
});

test('run modes: another cleaning mode while busy is refused and nothing is sent', async () => {
  await docked();
  await runModeCommand(RUN.bed);
  await waitForEvent('sweep');
  for (const other of [RUN.kitchen, RUN.clean]) {
    await runModeCommand(other);
    await sleep(500);
    assert.deepEqual(W.events(), []);
    assert.equal(runMode(), RUN.bed, 'Matterbridge refused the change as well');
  }
  assert.ok(lines.some((l) => l.includes("'Clean Kitchen (Main Floor)' not started: the vacuum is busy with 'Clean Bed'")));
  await docked();
});

test('run modes: the same room mode while paused resumes the run', async () => {
  await docked();
  await runModeCommand(RUN.den);
  await waitForEvent('sweep');
  p.commandGraceUntil = 0;
  await poll({ mode: 'PAUSE', charging: false });
  assert.deepEqual([op(), runMode()], [S.Paused, RUN.den]);
  await runModeCommand(RUN.den);
  await waitForEvent('clean');
  assert.deepEqual(W.events().filter((e) => e !== 'list'), ['clean'], 'resumed, not a new run');
  assert.equal(runMode(), RUN.den);
  await docked();
});

test('run modes: a room gone from the Wyze app does nothing and the real state comes back', async () => {
  await docked();
  const area = p.supportedAreas.find((a) => a.areaInfo.locationInfo.locationName === 'Living Room');
  p.supportedAreas = p.supportedAreas.filter((a) => a !== area);   // as after a room refresh
  await runModeCommand(RUN.living);
  await sleep(500);
  assert.deepEqual(W.events(), []);
  assert.ok(lines.some((l) => l.includes("'Clean Living Room' not started: that room is no longer in the Wyze app")));
  assert.equal(p.pokeStatusLoop, true);
  await poll();
  assert.deepEqual([op(), runMode()], [S.Charging, RUN.dock], 'the real state: docked and charging');
  p.supportedAreas.splice(1, 0, area);
});

test('"Clean" uses the rooms picked in Home; all of a floor\'s rooms, or none, clean the whole floor', async () => {
  await docked();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [2, 3, 4] } });
  await p.doSweeping();
  assert.deepEqual(W.events().slice(-1), ['sweep:[]']);
  await docked();
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:1', 'sweep:[]']);
  await docked();
});

test('pause and resume follow Matterbridge\'s rules: nothing is sent while docked', async () => {
  await docked();
  W.clearEvents();
  await dev.invokeBehaviorCommand('rvcOperationalState', 'resume', {});   // e.g. Alexa "resume" while docked
  await dev.invokeBehaviorCommand('rvcOperationalState', 'pause', {});
  await sleep(500);
  assert.deepEqual(W.events(), []);
  assert.equal(runMode(), RUN.dock);
});

test('resume of a paused room run: resumes it even with rooms just picked in Home', async () => {
  await docked();
  await runModeCommand(RUN.den);
  await waitForEvent('sweep');
  p.commandGraceUntil = 0;
  await poll({ mode: 'PAUSE', charging: false });
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [2] } });   // picked for the next run
  W.clearEvents();
  await dev.invokeBehaviorCommand('rvcOperationalState', 'resume', {});
  await waitForEvent('clean');
  assert.deepEqual(W.events().filter((e) => e !== 'list'), ['clean'], 'resumed, not a new run of the picked room');
  assert.equal(runMode(), RUN.den);
  p.newRoomsSelected = false;
  await docked();
  assert.equal(dev.state.serviceArea.currentArea, null, 'no current room once docked');
});

test('two starts in quick succession send one run', async () => {
  await docked();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [4] } });
  W.clearEvents();
  await Promise.all([p.doSweeping(), p.doSweeping()]);
  assert.deepEqual(W.events().filter((e) => e.startsWith('sweep')), ['sweep:[13]']);
  assert.ok(lines.some((l) => l.includes('A start is already being sent')));
  await docked();
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
  p.selectedAreas = [3, 4];
  await dev.updateAttribute(SERVICE_AREA, 'selectedAreas', [3, 4], log);
  await p.refreshRooms();
  assert.deepEqual(areas(), ['8:Cook Room@1', '3:Living Room@1', '9:Pantry@1', '6:Bed@2']);
  assert.deepEqual([...dev.state.serviceArea.selectedAreas], [3]);
  assert.ok(lines.some((l) => l.includes('reaches the run modes')), 'says Alexa\'s list updates at restart');
  const n = lines.length;
  await p.refreshRooms();
  assert.equal(lines.slice(n).some((l) => l.includes('room list changed')), false);
});

test('room names Matter would refuse: same name twice, very long names; Home gets a valid list', async () => {
  const longFloor = 'Floor ' + 'F'.repeat(70);   // Matter: map names at most 64 bytes
  const longRoom = 'Room ' + 'é'.repeat(70);     // Matter: area names at most 128 bytes
  W.set({ maps: [{ name: 'Main Floor', rooms: ['Bath', 'Bath', longRoom] }, { name: longFloor, rooms: ['Den'] }] });
  const n = lines.length;
  await p.refreshRooms();
  assert.deepEqual(lines.slice(n).filter((l) => l.startsWith('error:')), [], 'Matter accepted the list');
  const names = dev.state.serviceArea.supportedAreas.map((a) => a.areaInfo.locationInfo.locationName);
  assert.equal(names.filter((x) => x === 'Bath').length, 1, 'one Bath');
  assert.ok(names.every((x) => Buffer.byteLength(x) <= 128));
  assert.ok(dev.state.serviceArea.supportedMaps.every((m) => Buffer.byteLength(m.name) <= 64));
  assert.ok(lines.slice(n).some((l) => l.includes('listed once and cleaned together')));
  // Picking "Bath" cleans both Wyze rooms of that name; the long floor is switched to by its full name.
  await docked();
  const bath = dev.state.serviceArea.supportedAreas.find((a) => a.areaInfo.locationInfo.locationName === 'Bath').areaId;
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [bath] } });
  await p.doSweeping();
  assert.deepEqual(W.events().slice(-1), ['sweep:[11, 12]']);
  await docked();
  W.clearEvents();
  const den = dev.state.serviceArea.supportedAreas.find((a) => a.areaInfo.locationInfo.locationName === 'Den').areaId;
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [den] } });
  await p.doSweeping();
  assert.deepEqual(W.events(), ['set_map:2', 'sweep:[]'], 'only room upstairs: whole floor');
  await docked();
});

test('maps without rooms or names, and no current map (as wyze-sdk can report): no crash, whole floor cleans', async () => {
  W.set({ maps: [{ name: null, rooms: null }, { name: 'Up', rooms: ['Bed', null] }] });
  const n = lines.length;
  await p.refreshRooms();
  assert.deepEqual(lines.slice(n).filter((l) => l.startsWith('error:') || l.includes('Could not read')), []);
  assert.deepEqual(dev.state.serviceArea.supportedAreas.map((a) => a.areaInfo.locationInfo.locationName), ['Bed']);
  await docked();
  W.set({ no_current_map: true });
  W.clearEvents();
  await dev.commandHandler.executeHandler('selectAreas', { request: { newAreas: [] } });
  await p.doSweeping();
  assert.deepEqual(W.events().slice(-1), ['sweep:[]'], 'whole floor even without a current map');
  W.set({ no_current_map: false });
  await docked();
});

test('Wyze not answering status checks: Home shows an error after 3 in a row, the real state once it answers', async () => {
  await docked();
  W.set({ info_error: true });
  await poll();
  await poll();
  assert.notEqual(op(), S.Error, 'not after one or two');
  await poll();
  assert.equal(op(), S.Error);
  assert.equal(dev.state.rvcOperationalState.operationalError.errorStateDetails, 'Wyze cloud not reachable');
  W.set({ info_error: false });
  await poll();
  assert.deepEqual([op(), runMode()], [S.Charging, RUN.dock]);
  assert.ok(lines.some((l) => l.includes('Wyze answers again')));
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
