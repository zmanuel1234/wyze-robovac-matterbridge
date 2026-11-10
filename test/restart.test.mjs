// Restarts with saved Matter state. Matter keeps the vacuum's current run mode across
// restarts but rebuilds the list of run modes, and refuses to start the device when the
// saved mode is missing from the new list. These tests restart the plugin on the same
// storage while a room run mode is current, with the room list unreadable or changed.
import './v4only.cjs';
import '@matter/nodejs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { Environment } from '@matter/general';
import { ServerNode } from '@matter/node';
import { DeviceTypeId, VendorId } from '@matter/types/datatype';
import { AnsiLogger, LogLevel } from 'matterbridge/logger';
import { MatterbridgeDynamicPlatform } from 'matterbridge';
import initializePlugin from '../dist/index.js';
import { fakeWyze, PYTHON, sleep } from './setup.mjs';

process.env.WYZE_MAP_SWITCH_POLL = '0.2';
process.env.WYZE_MAP_SWITCH_WAIT = '2';

const W = fakeWyze();
const lines = [];
const BED = 15;   // "Clean Bed", upstairs, in the fake Wyze room list

// Start the plugin and its Matter device on W's storage, as Matterbridge would.
async function start() {
  const env = Environment.default;
  env.vars.set('path.root', path.join(W.dir, 'matter'));
  env.vars.set('runtime.signals', false);
  env.vars.set('endpoint.validation', 'strict');
  env.vars.set('log.level', 5);
  const server = await ServerNode.create({
    id: 'WyzeRestart', environment: env, network: { port: 5940 + Math.floor(Math.random() * 400) },
    productDescription: { name: 'WyzeRestart', deviceType: DeviceTypeId(0x0074), vendorId: VendorId(0xfff1), productId: 0x8000 },
    basicInformation: { vendorId: VendorId(0xfff1), vendorName: 'Test', productId: 0x8000, productName: 'WyzeRestart',
      nodeLabel: 'WyzeRestart', hardwareVersion: 1, softwareVersion: 1 },
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
  const log = new AnsiLogger({ logName: 'WyzeRestart', logLevel: LogLevel.DEBUG });
  for (const lvl of ['info', 'debug', 'notice', 'warn', 'error']) {
    log[lvl] = (...a) => { lines.push(`${lvl}: ${a.map(String).join(' ')}`); };
  }
  const cfg = { name: 'matterbridge-wyze-robovac-plus', type: 'DynamicPlatform', whiteList: [], blackList: [], enableServerRvc: true,
    username: 'me', password: 'pw', key_id: 'k', api_key: 'a', totpKey: '', pythonPath: PYTHON, tokenFile: W.tokenFile };
  const p = initializePlugin(mb, log, cfg);
  p.constructor.ROOM_LIST_RETRY_MS = 50;
  p.constructor.VACUUM_RETRY_MS = 50;
  let dev, addError;
  p.registerDevice = async (d) => {
    try {
      await server.add(d);
      dev = d;
    } catch (e) {
      addError = e;
    }
  };
  Object.assign(p, { ready: Promise.resolve(), clearSelect: async () => {}, setSelectDevice: () => {}, validateDevice: () => true,
    startStatusLoop: async () => {} });
  await p.onStart('test');
  return { p, dev, addError, server };
}

async function stop({ p, server }) {
  p.stopping = true;
  await p.onShutdown('test restart').catch(() => {});
  await server.close().catch(() => {});
}

// Power loss or a crash: Matter's storage as it was, the plugin never told to shut down.
async function crash({ p, server }) {
  p.stopping = true;
  p.worker.stop();
  // Matterbridge's own platform cleanup (timers), not the plugin's shutdown, which would
  // change the stored run mode.
  await MatterbridgeDynamicPlatform.prototype.onShutdown.call(p, 'test crash').catch(() => {});
  await server.close().catch(() => {});
}

async function waitForEvent(prefix) {
  for (let i = 0; i < 100 && !W.events().some((e) => e.startsWith(prefix)); i++) {
    await sleep(100);
  }
  await sleep(500);   // the start finishes writing Home's state
}

after(() => W.cleanup());

test('restart while "Clean Bed" is current and Wyze\'s room list is unreadable: the device still starts', async () => {
  // First start: clean the bedroom through Matterbridge's run-mode server, then stop
  // with that mode current (as when the Pi reboots during a run).
  let run = await start();
  assert.ok(run.dev, `device started: ${run.addError?.message ?? ''}`);
  W.clearEvents();
  await run.dev.invokeBehaviorCommand('rvcRunMode', 'changeToMode', { newMode: BED });
  await waitForEvent('sweep');
  assert.equal(run.dev.state.rvcRunMode.currentMode, BED);
  W.set({ mode: 'SWEEPING', charging: false });
  await crash(run);

  // Second start: Wyze answers, but not with the room list.
  W.set({ maps_error: true });
  lines.length = 0;
  run = await start();
  assert.ok(run.dev, `device started: ${run.addError?.message ?? ''}`);
  assert.equal(run.dev.state.rvcRunMode.currentMode, BED, 'Matter restored the saved mode');
  const labels = run.dev.state.rvcRunMode.supportedModes.map((m) => m.label);
  assert.ok(labels.includes('Clean Bed') && labels.includes('Clean Den: East'), 'saved modes still listed');
  assert.ok(lines.some((l) => l.includes('could not read the vacuum\'s rooms') || l.includes('Could not read the vacuum\'s rooms')));
  assert.ok(lines.some((l) => l.startsWith('warn:') && l.includes('do nothing until the plugin is restarted')));

  // Choosing one now does nothing (no room to clean), and says why.
  W.set({ mode: 'IDLE', charging: true });
  await run.p.getStatus();
  W.clearEvents();
  await run.dev.invokeBehaviorCommand('rvcRunMode', 'changeToMode', { newMode: 13 });
  await sleep(500);
  assert.deepEqual(W.events().filter((e) => e !== 'list'), []);
  assert.ok(lines.some((l) => l.includes("'Clean Den: East' not started: the room list could not be read")));
  await run.p.getStatus();
  assert.equal(run.dev.state.rvcRunMode.currentMode, 1, 'the real state (docked) is shown again');
  await stop(run);

  // Third start: Wyze is back, without the upstairs floor. Modes of gone rooms are dropped,
  // which is safe now that the saved current mode is Dock.
  W.set({ maps_error: false, maps: [{ name: 'Main Floor', rooms: ['Kitchen', 'Living Room', 'Den: East'] }] });
  run = await start();
  assert.ok(run.dev, `device started: ${run.addError?.message ?? ''}`);
  assert.deepEqual(run.dev.state.rvcRunMode.supportedModes.map((m) => `${m.mode}:${m.label}`),
    ['1:Dock', '2:Clean', '10:Clean All', '11:Clean Kitchen', '12:Clean Living Room', '13:Clean Den: East']);
  await stop(run);
});

test('restart while a room mode is current and that room was deleted in the Wyze app: still starts', async () => {
  W.set({ maps: [{ name: 'Main Floor', rooms: ['Kitchen', 'Living Room', 'Den: East'] }], mode: 'IDLE', charging: true });
  let run = await start();
  assert.ok(run.dev);
  W.clearEvents();
  await run.dev.invokeBehaviorCommand('rvcRunMode', 'changeToMode', { newMode: 12 });   // Clean Living Room
  await waitForEvent('sweep');
  assert.equal(run.dev.state.rvcRunMode.currentMode, 12);
  await crash(run);

  W.set({ maps: [{ name: 'Main Floor', rooms: ['Kitchen', 'Den: East'] }] });   // Living Room deleted
  run = await start();
  assert.ok(run.dev, `device started: ${run.addError?.message ?? ''}`);
  assert.equal(run.dev.state.rvcRunMode.currentMode, 12);
  assert.ok(run.dev.state.rvcRunMode.supportedModes.some((m) => m.mode === 12 && m.label === 'Clean Living Room'),
    'the saved current mode is kept in the list');
  await stop(run);
});

test('a normal shutdown during a room run stores "Clean", which older versions also list', async () => {
  W.set({ maps: [{ name: 'Main Floor', rooms: ['Kitchen', 'Den: East'] }], mode: 'IDLE', charging: true });
  let run = await start();
  await run.p.getStatus();   // the first status check shows the real state (docked)
  assert.equal(run.dev.state.rvcRunMode.currentMode, 1);
  W.clearEvents();
  await run.dev.invokeBehaviorCommand('rvcRunMode', 'changeToMode', { newMode: 11 });   // Clean Kitchen
  await waitForEvent('sweep');
  assert.equal(run.dev.state.rvcRunMode.currentMode, 11);
  await stop(run);
  run = await start();
  assert.equal(run.dev.state.rvcRunMode.currentMode, 2);
  await stop(run);
});

test('Wyze unreachable at boot: starts with the vacuum found last time, loads the rooms once Wyze answers', async () => {
  W.set({ maps: [{ name: 'Main Floor', rooms: ['Kitchen', 'Den: East'] }], mode: 'IDLE', charging: true });
  await stop(await start());   // an earlier start that found the vacuum
  W.set({ devices_error: true, maps_error: true });
  fs.rmSync(W.tokenFile + '.devices.json', { force: true });   // no saved lookup in the helper either
  lines.length = 0;
  const run = await start();
  assert.ok(run.dev, `device started: ${run.addError?.message ?? ''}`);
  assert.ok(lines.some((l) => l.includes('using the vacuum found last time')));
  assert.equal(run.p.roomsLoaded, false);
  // Wyze is back: the status loop reads the room list without waiting 6 hours.
  W.set({ devices_error: false, maps_error: false });
  run.p.lastRoomRefresh = 0;
  delete run.p.startStatusLoop;
  const loop = run.p.startStatusLoop();
  for (let i = 0; i < 100 && !run.p.roomsLoaded; i++) {
    await sleep(100);
  }
  run.p.stopping = true;
  run.p.pokeStatusLoop = true;
  await loop;
  assert.equal(run.p.roomsLoaded, true);
  assert.deepEqual(run.dev.state.serviceArea.supportedAreas.map((a) => a.areaInfo.locationInfo.locationName), ['Kitchen', 'Den: East']);
  await stop(run);
});

test('no errors logged', () => {
  assert.deepEqual(lines.filter((l) => l.startsWith('error:')), []);
});
