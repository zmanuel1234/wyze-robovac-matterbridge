/**
 * This file contains the class RoboVacMatterbridgeDynamicPlatform.
 *
 * @file platform.ts
 * @author Rob Coben
 * @license Apache-2.0
 *
 * Copyright 2025, 2026 Rob Coben
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { MatterbridgeEndpoint, MatterbridgeDynamicPlatform, PlatformConfig } from 'matterbridge';
import { RoboticVacuumCleaner } from 'matterbridge/devices';
import { AnsiLogger, debugStringify } from 'matterbridge/logger';
import { RvcRunMode, PowerSource, ServiceArea, RvcOperationalState, RvcCleanMode } from 'matterbridge/matter/clusters';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout } from 'timers/promises';
import { PyWorker, PyResult } from './pyWorker.js';


// What a floor/room run mode cleans. unavailable: listed only so a mode Matter saved stays
// valid (see buildRunModes); choosing it does nothing.
type RunTarget = { mapId? : number, areaId? : number, label : string, unavailable? : boolean };

export class RoboVacMatterbridgeDynamicPlatform extends MatterbridgeDynamicPlatform {

  // How long after a Home command the vacuum gets to react (Wyze takes 10-15 s)
  // before a poll that still shows the old state may overwrite what Home displays.
  static readonly COMMAND_GRACE_MS = 40_000;

  // Matter clean-mode number -> Wyze suction level understood by vacuumSetSuction.py
  static readonly SUCTION_BY_MODE : Record<number, string> = { 1: 'standard', 3: 'quiet', 4: 'strong' };
  // ... and back: Wyze suction level reported by getVacuumStatus.py -> Matter clean mode
  static readonly MODE_BY_SUCTION : Record<string, number> = { standard: 1, quiet: 3, strong: 4 };

  // Battery percentages at or below which Home is told the battery is low / critically low
  // (Home shows a low-battery warning). Not while the vacuum is charging on its dock.
  static readonly BATTERY_WARNING = 20;
  static readonly BATTERY_CRITICAL = 10;

  // How often the room list is read again from Wyze (only while the vacuum is docked
  // and idle), so rooms renamed or added in the Wyze app show up without a restart.
  static readonly ROOM_REFRESH_MS = 6 * 60 * 60 * 1000;
  static ROOM_LIST_RETRY_MS = 15_000;   // between tries at startup (tests shorten it)
  static VACUUM_RETRY_MS = 30_000;      // the same for finding the vacuum

  // Run modes. 1 and 2 are the ones every controller knows; Apple Home starts a clean of
  // the rooms picked in its room list with 2. Controllers without a room list (Alexa)
  // get one extra run mode per floor ("Clean All") and per room ("Clean Kitchen"),
  // numbered from 10 so they can never be mistaken for a clean-mode number (1, 3, 4).
  static readonly RUN_DOCK = 1;
  static readonly RUN_CLEAN = 2;
  static readonly FIRST_TARGET_MODE = 10;
  static readonly MAX_MODE = 254;
  // The Wyze room list's whole-floor entry (see getVacuumFloors.py); never shown in Home.
  static readonly ENTIRE_FLOOR = '*Entire Floor*';

  // Status checks in a row that fail (Wyze unreachable, login refused) before Home shows
  // an error instead of the last state it was told.
  static readonly STATUS_FAILURES_SHOWN = 3;
  // While the room list could not be read, how often to try again.
  static readonly ROOM_RETRY_MS = 5 * 60 * 1000;

  // Oldest Matterbridge this version has been tested with.
  static readonly MIN_MATTERBRIDGE = '3.11.0';

  private nickname : string = 'RoboVac';
  private macAddr : string = '';
  private currentStatus : string = '';
  private oldStatus : string = '';
  private lastAppliedState : string = '';   // run mode + operational state last shown in the Home app
  private commandGraceUntil : number = 0;   // until then, polls don't overwrite a state set by a Home command
  private suctionGraceUntil : number = 0;   // the same for a suction level just chosen in Home
  private batteryLevel : number = 0;
  private rooms: string[] = [];
  private supportedMaps : { mapId: number; name: string; }[] = [];
  private supportedAreas: { areaId: number, mapId: number,
                            areaInfo: { locationInfo: { locationName: string, floorNumber: number, areaType: null },
                                        landmarkInfo: null } }[] = [];

  private selectedAreas : number[] = [];
  // Area and map IDs by name, so a room keeps its ID when the room list is read again.
  private readonly areaIds = new Map<string, number>();   // "floor<TAB>room" -> areaId
  private readonly mapIds = new Map<string, number>();    // floor name -> mapId
  private readonly fullNames = new Map<string, string>(); // "map:<id>"/"area:<id>" -> name as in Wyze
  private lastRoomRefresh = 0;
  private roomsLoaded = false;   // the room list was read from Wyze at least once
  private statusFailures = 0;    // status checks in a row that failed
  private starting = false;      // a start or resume is being sent to the vacuum
  private idleOnDock = false;   // last status check: docked, idle and no fault
  private isDocked = true;
  private fault : string = 'None';   // Wyze fault name from the last status check, e.g. 'COLLISION_EXCEPTION'
  private offline = false;   // Wyze says the vacuum is not connected (battery dead, switched off, out of Wi-Fi)
  private newRoomsSelected : boolean = false;

  // The run modes offered at startup (Matter does not allow the list to change while
  // running), what each floor/room mode cleans, and the mode the current run used.
  private runModes : { label: string, mode: number, modeTags: { value: number }[] }[] = [];
  private readonly modeTargets = new Map<number, RunTarget>();
  private activeRunMode : number = RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN;
  private lastShownMode : number = RoboVacMatterbridgeDynamicPlatform.RUN_DOCK;   // as saved in run-modes.json
  private savedRunModes : Record<string, { mode : number, label : string }> = {};

  private pokeStatusLoop : boolean = false;
  private stopping : boolean = false;        // set on shutdown; ends the status loop
  private statusCheck : Promise<number> | undefined;   // the status check in progress, if any
  private statusRefreshInterval : number = 0;
  private oldRefreshInterval : number = 0;

  private roboticVacuum: MatterbridgeEndpoint | undefined;
  private readonly worker : PyWorker;   // the long-running Python helper that talks to Wyze

  // The type Matterbridge passes in was renamed across 3.x releases; take it from the base class.
  constructor(matterbridge: ConstructorParameters<typeof MatterbridgeDynamicPlatform>[0], log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    // Verify that Matterbridge is the correct version
    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function'
                    || !this.verifyMatterbridgeVersion(RoboVacMatterbridgeDynamicPlatform.MIN_MATTERBRIDGE)) {
      throw new Error(
        `This plugin requires Matterbridge ${RoboVacMatterbridgeDynamicPlatform.MIN_MATTERBRIDGE} or later. ` +
        `Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} in the frontend.`,
      );
    }

    this.log.info(`Initializing platform: ${this.config.name} ${this.buildInfo()}`);
    if (config.whiteList === undefined) {
      config.whiteList = [];
    }
    if (config.blackList === undefined) {
      config.blackList = [];
    }
    if (config.enableRVC !== undefined) {
      delete config.enableRVC;
    }
    if (config.enableServerRvc === undefined) {
      config.enableServerRvc = true;
    }
    // Settings that no longer exist: 'mfaCode' (2FA now uses 'totpKey'), 'path2py_stubs'
    // (the bundled helpers are always used) and 'debugLevel' (use Matterbridge's log level).
    for (const old of ['mfaCode', 'path2py_stubs', 'debugLevel']) {
      delete config[old];
    }
    this.worker = new PyWorker({
      python: String(this.config.pythonPath || 'python3'),
      script: path.join(this.helperDir(), 'wyze_worker.py'),
      secrets: () => ({
        WYZE_EMAIL: String(this.config.username ?? ''),
        WYZE_PASSWORD: String(this.config.password ?? ''),
        WYZE_KEY_ID: String(this.config.key_id ?? ''),
        WYZE_API_KEY: String(this.config.api_key ?? ''),
        WYZE_TOTP_KEY: String(this.config.totpKey ?? ''),
        WYZE_TOKEN_FILE: this.tokenFile(),
      }),
      timeoutMs: 90_000,
      log: (m) => this.log.info(m),
    });

    const missing = ['username', 'password', 'key_id', 'api_key'].filter((k) => !String(config[k] ?? '').trim());
    if (missing.length > 0) {
      this.log.error(`Missing required setting(s): ${missing.join(', ')}. ` +
        'A login will fail unless a valid saved token already exists.');
    }
  }

  override async onStart(reason: string) {
    const out : string = reason ? reason : 'none';
    this.myLogger(`onStart - RoboVac called with reason = '${out}'`);

    // Wait for the platform to start
    await this.ready;
    await this.clearSelect();

    // Get the vacuum's nickname and MAC. Wyze can be briefly unreachable while the
    // Pi boots, so try a few times before giving up.
    for( let attempt = 1; attempt <= 3 && !this.macAddr && !this.stopping; attempt++ ) {
      if( attempt > 1 ) {
        await setTimeout(RoboVacMatterbridgeDynamicPlatform.VACUUM_RETRY_MS);
      }
      await this.findDevices();
    }
    if( !this.macAddr && !this.stopping ) {
      // Wyze unreachable at boot: start with the vacuum found last time, so it is still in
      // Home; commands and the room list work once Wyze answers again.
      const last = this.readLastVacuum();
      if( last ) {
        [this.nickname, this.macAddr] = [last.nickname, last.mac];
        this.log.warn(`Wyze did not answer; using the vacuum found last time ('${this.nickname}'). ` +
          'It is updated once Wyze can be reached.');
      }
    }
    if( !this.macAddr ) {
      this.log.error('No Wyze robot vacuum found on the account (see the messages above). ' +
        'Fix the settings or the connection, then restart the plugin.');
      return;
    }

    // The room list decides the run modes, which Matter fixes when the device starts:
    // try a few times, as for the vacuum itself.
    for( let attempt = 1; attempt <= 3 && !this.stopping; attempt++ ) {
      if( attempt > 1 ) {
        await setTimeout(RoboVacMatterbridgeDynamicPlatform.ROOM_LIST_RETRY_MS);
      }
      if( await this.getRoomList() ) {
        break;
      }
    }
    this.setupSupportedAreas();
    this.runModes = this.buildRunModes();

    // *********************** Create a vacuum *****************************
    /*
    The RVC is supported correctly by the Home app (all commands work).

    The bad news is that right now the Apple Home app only shows the RVC as a single device (not bridged)
    or a single device in the bridge.

    If the RVC is in a bridge with other devices, the whole Home app crashes... so don't try it.
    If your controller is Apple Home use server mode for the RVC.
    */
    this.roboticVacuum = new RoboticVacuumCleaner(
      'Robot Vacuum',
      this.macAddr,
      this.config.enableServerRvc === true ? 'server' : undefined,
      RoboVacMatterbridgeDynamicPlatform.RUN_DOCK, // currentRunMode
      this.runModes, // supportedRunModes: Dock, Clean, then one per floor and room
      1, // currentCleanMode
      // Matter requires at least two clean modes. They map to the S200's suction
      // levels. Mode 2 is skipped on purpose: older Matterbridge versions send
      // clean-mode changes to the plain 'changeToMode' handler, where 2 means "start".
      [
        { label: 'Standard', mode: 1, modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }] },
        { label: 'Quiet', mode: 3, modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: RvcCleanMode.ModeTag.Quiet }] },
        { label: 'Strong', mode: 4, modeTags: [{ value: RvcCleanMode.ModeTag.Vacuum }, { value: RvcCleanMode.ModeTag.Max }] },
      ], // supportedCleanModes
      null, // currentPhase
      null, // phaseList
      undefined, // operationalState
      undefined, // operationalStateList
      [
        {
          areaId: 1,
          mapId: 1,
          areaInfo: { locationInfo: { locationName: 'Entire floor', floorNumber: 0, areaType: null },
            landmarkInfo: null },
        },
      ], // supportedAreas
      [], // selectedAreas
      null, // currentArea: no run yet
      [
        {
          mapId: 1,
          name: 'Current floor',
        },
      ], // supportedMaps
    );

    if (this.config.enableServerRvc === true) {
      this.log.notice('The vacuum runs as its own Matter device (server mode)');
    }

    /*
     * Matterbridge runs these handlers first and then sets the state it expects
     * (Paused, Running, Returning to dock) itself. So when Wyze refuses a command,
     * the real state is written by the next status check, after the handler returns
     * (see afterCommand), not from inside the handler, where it would be overwritten.
     */
    // Matterbridge runs these before its own checks, then accepts pause only while running
    // or returning to the dock, and resume only while paused: the same is done here, so
    // nothing is sent to the vacuum for a command Home is told was refused.
    const OS = RvcOperationalState.OperationalState;
    const opStateOf = (attributes : unknown) =>
      Number((attributes as { operationalState?: number } | undefined)?.operationalState ?? OS.Running);
    this.roboticVacuum.addCommandHandler('pause', async ({ attributes }) => {
      this.log.info('\'pause\' handler called - RoboVac');
      const state = opStateOf(attributes);
      if( state !== OS.Running && state !== OS.SeekingCharger ) {
        this.log.info(state === OS.Paused ? 'Already paused' : 'Pause not sent: the vacuum is not cleaning or returning');
        return;
      }
      if( await this.pauseSweeping() ) {
        this.lastAppliedState = this.stateKey(this.activeRunMode, OS.Paused);
        this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
        this.pokeStatusLoop = true;
      }
    });

    this.roboticVacuum.addCommandHandler('resume', async ({ attributes }) => {
      this.log.info('\'resume\' handler called - RoboVac');
      const state = opStateOf(attributes);
      if( state !== OS.Paused ) {
        this.log.info(state === OS.Running ? 'Already cleaning' : 'Resume not sent: the vacuum is not paused');
        return;
      }
      this.sweepInBackground(undefined, this.activeRunMode, true);
    });

    // Returns as soon as the dock command is sent: Matterbridge shows "returning to dock"
    // in the Home app once this handler returns, and the status loop tracks the rest.
    // (The original version waited here until the vacuum had docked, which held the
    // Home app's command, and the tile, for minutes.)
    this.roboticVacuum.addCommandHandler('goHome', async () => {
      this.log.info('\'goHome\' handler called - RoboVac');
      await this.sendHome();
    });

    this.roboticVacuum.addCommandHandler('selectAreas', async ({ request }) => {
      const { newAreas } = request as ServiceArea.SelectAreasRequest;
      this.selectedAreas.length = 0; // Clear the array
      for (const area of newAreas) {
        this.selectedAreas.push( area );
      }
      this.newRoomsSelected = true;
      this.myLogger(`'selectAreas' handler called. Selected areas: ${this.selectedAreas?.join(', ')}`);
    });

    // Registered under the cluster's own name, so a clean-mode change can never land here.
    // Matterbridge runs this before its own checks, then refuses a switch from one
    // cleaning mode to another while the vacuum is busy; the same is skipped here.
    this.roboticVacuum.addCommandHandler('RvcRunMode.changeToMode', async ({ request, attributes }) => {
      const mode = Number(request.newMode);
      const current = Number((attributes as { currentMode?: number } | undefined)?.currentMode ?? this.currentRunMode());
      const { RUN_DOCK, RUN_CLEAN } = RoboVacMatterbridgeDynamicPlatform;
      this.myLogger(`'RvcRunMode.changeToMode' handler called - RoboVac. New mode = ${mode}, current = ${current}`);
      if( mode === RUN_DOCK ) {   // Matterbridge then shows "returning to dock"
        await this.sendHome();
        return;
      }
      if( mode !== current && current !== RUN_DOCK ) {
        this.log.info(`'${this.modeLabel(mode)}' not started: the vacuum is busy with '${this.modeLabel(current)}'. ` +
          'Send it to the dock first.');
        return;
      }
      if( mode === RUN_CLEAN ) {   // Start the rooms picked in Home, or resume if paused
        this.sweepInBackground();
        return;
      }
      const target = this.modeTargets.get(mode);
      if( !target ) {
        this.log.info(`Unknown run mode ${mode}; nothing started`);
        return;
      }
      // Matterbridge shows this mode (and "running") once the handler returns.
      this.rememberShownMode(mode);
      const roomGone = target.areaId !== undefined && !this.supportedAreas.some((a) => a.areaId === target.areaId);
      if( target.unavailable || roomGone ) {
        this.log.warn(`'${target.label}' not started: ` + (target.unavailable && !this.roomsLoaded
          ? 'the room list could not be read from Wyze when the plugin started. Restart the plugin.'
          : 'that room is no longer in the Wyze app. Restart the plugin to update the list of run modes.'));
        this.showRealStateSoon();
        return;
      }
      // The same mode again: resume if paused (or start it if the vacuum is in fact idle).
      this.sweepInBackground(target, mode, mode === current);
    });

    // Matterbridge 3.11+ calls this exact name for clean-mode changes (it only
    // reaches it while the vacuum is idle). Maps the mode to a Wyze suction level.
    this.roboticVacuum.addCommandHandler('RvcCleanMode.changeToMode', async ({ request }) => {
      const level = RoboVacMatterbridgeDynamicPlatform.SUCTION_BY_MODE[request.newMode];
      if( level === undefined ) {
        this.log.info(`Unknown clean mode ${request.newMode}; suction left unchanged`);
        return;
      }
      if( !(await this.ensureOnline(`Suction level ${level}`)) ) {
        this.suctionGraceUntil = 0;
        return;
      }
      this.log.info(`Setting suction level to ${level}`);
      const r = await this.py('vacuumSetSuction.py', [this.nickname, level]);
      if( r.ok ) {
        // Wyze may still report the old level for a few seconds: don't flip Home back.
        this.suctionGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
      } else {
        // Matterbridge shows the requested mode once this returns: put the real one back.
        this.log.info(`Could not set suction level: ${r.stderr}`);
        this.suctionGraceUntil = 0;
        this.pokeStatusLoop = true;
      }
    });

    this.myLogger('before addDevice');
    this.roboticVacuum = await this.addDevice(this.roboticVacuum);

    // Rooms & floors as defined in the Wyze app. Without a room list (Wyze unreachable),
    // the single default area stays: starting then cleans the whole current floor.
    await this.applyRooms();

    this.pokeStatusLoop = false;
    this.startStatusLoop().catch((e) => this.log.error(`Status loop ended: ${e instanceof Error ? e.message : String(e)}`));
  }

  override async onConfigure() {
    await super.onConfigure();
    this.myLogger('onConfigure called - RoboVac');
    if( this.roboticVacuum ) {
      await this.getStatus();
    }
  }

  override async onShutdown(reason?: string) {
    this.stopping = true;        // ends the status loop
    this.pokeStatusLoop = true;
    // Matter stores the current run mode for the next start. A room mode ("Clean Bed")
    // is stored as plain "Clean" (also true), which every version of this plugin lists,
    // so going back to an older version after an update can't hit an unknown mode.
    // Only once Matter took it is the room mode dropped from what the next start keeps.
    try {
      if( this.roboticVacuum && this.currentRunMode() >= RoboVacMatterbridgeDynamicPlatform.FIRST_TARGET_MODE ) {
        const stored = await this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode',
          RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN, this.log);
        if( stored !== false ) {
          this.rememberShownMode(RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN);
        }
      }
    } catch {
      // the device never started (or is gone): nothing to store; shut down the rest
    }
    this.worker.stop();
    await super.onShutdown(reason);
    const out : string = reason ? reason : 'none';
    this.myLogger(`onShutdown - RoboVac called with reason = '${out}'`);
  }

  async addDevice(device: MatterbridgeEndpoint): Promise<MatterbridgeEndpoint | undefined> {
    if (!device.serialNumber || !device.deviceName) {
      this.log.info( 'Device not added. serialNumber or deviceName not set.' );
      return;
    }
    this.setSelectDevice(device.serialNumber, device.deviceName, undefined, 'hub');
    if (this.validateDevice(device.deviceName)) {
      await this.registerDevice(device);
      return device;
    } else {
      return undefined;
    }
  }

  // ========================= Wyze API interface ==============================================
  //
  // Each method sends one command to the Python helper (see pyWorker.ts) and waits for
  // the answer: the command's output, or why it failed. No command waits longer than
  // 90 seconds.

  /***************** SetFloor **********************/

  async setFloor(mapId : number | undefined) {
    const floorName = this.floorFullName(mapId);
    if( floorName === undefined ) {
      return;   // no room list from Wyze: clean whichever floor is current
    }
    const r = await this.py('setVacuumFloor.py', [this.nickname, floorName]);
    if( r.ok ) {
      this.myLogger(`Current map set to floor '${floorName}'`);
    } else {
      this.log.info(`Could not set the floor to '${floorName}': ${r.stderr}`);
    }
  }

  /***************** Resume, pause, dock, start **********************/

  // Each returns true when Wyze accepted the command.

  // Resume after a pause.
  async startCleaning() : Promise<boolean> {
    return await this.ensureOnline('Resume')
      && this.afterCommand('Resume', await this.py('vacuumStartClean.py', [this.nickname]));
  }

  async pauseSweeping() : Promise<boolean> {
    return await this.ensureOnline('Pause')
      && this.afterCommand('Pause', await this.py('vacuumPauseSweep.py', [this.nickname]));
  }

  async stopSweeping() : Promise<boolean> {
    return await this.ensureOnline('Return to dock')
      && this.afterCommand('Return to dock', await this.py('vacuumStopSweep.py', [this.nickname]));
  }

  // Start a new run of these rooms on the current floor; no rooms: the whole floor.
  async startSweeping(roomIds : number[]) : Promise<boolean> {
    if( !(await this.ensureOnline('Start cleaning')) ) {
      return false;
    }
    const roomNames : string[] = roomIds
      .map((id) => this.roomFullName(id))
      .filter((name) : name is string => name !== undefined);
    if( roomNames.length === 0 ) {
      roomNames.push(RoboVacMatterbridgeDynamicPlatform.ENTIRE_FLOOR);   // matches no room: the helper cleans the whole floor
    }
    this.log.info(`Rooms to be swept = '${roomNames.join(', ')}'`);
    return this.afterCommand('Start cleaning', await this.py('vacuumStartSweep.py', [this.nickname, ...roomNames]));
  }

  // When Wyze refuses or fails a command (for example "already docked"), the Home app
  // is showing a state the vacuum isn't in: have the status loop write the real one
  // straight away, once the command handler has returned.
  afterCommand(what : string, r : { ok : boolean, stdout : string, stderr : string }) : boolean {
    if( r.ok ) {
      this.myLogger(`${what}: ${r.stdout.trim()}`);
      return true;
    }
    this.log.info(`${what} not done: ${r.stderr}`);
    this.commandGraceUntil = 0;
    this.lastAppliedState = '';
    this.pokeStatusLoop = true;
    return false;
  }

  // Dock command from Home (goHome, or run mode Idle). Matterbridge shows "returning
  // to dock" once the handler returns but leaves the run mode alone, so forget what
  // was shown: the first check after the grace period writes both.
  async sendHome() {
    if( await this.stopSweeping() ) {
      this.lastAppliedState = '';
      this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
      this.pokeStatusLoop = true;
    }
  }

  /***************** Status **********************/

  // Polls the vacuum, updates the Home app, and returns the seconds until the next poll.
  // Callers arriving while a check is already running share its result, so two checks
  // never run (and write to the Home app) at the same time.
  getStatus() : Promise<number> {
    if( !this.statusCheck ) {
      this.statusCheck = this.checkStatus().finally(() => {
        this.statusCheck = undefined;
      });
    }
    return this.statusCheck;
  }

  private async checkStatus() : Promise<number> {
    const r = await this.py('getVacuumStatus.py', [this.nickname]);
    if( !r.ok ) {
      this.log.info(`Status check failed: ${r.stderr}`);
      this.statusFailures++;
      if( this.statusFailures >= RoboVacMatterbridgeDynamicPlatform.STATUS_FAILURES_SHOWN && !this.offline ) {
        await this.showUnreachable();
      }
      return this.statusRefreshInterval || this.interval('busyStatusCheckRefreshInterval');
    }
    if( this.statusFailures >= RoboVacMatterbridgeDynamicPlatform.STATUS_FAILURES_SHOWN ) {
      this.log.info('Wyze answers again');
      this.lastAppliedState = '';   // write the real state again below
    }
    this.statusFailures = 0;
    // "mode:battery:is_charging:fault:suction:online:online_since",
    // e.g. "VacuumMode.IDLE:87:True:None:quiet:True:1762149273"
    const fields = r.stdout.trim().split(':');
    // While the vacuum is offline Wyze keeps reporting its last known state, which would
    // show in Home as if it were live. Only an explicit 'False' counts: older helpers and
    // devices that don't report it are treated as online.
    if( (fields[5] ?? '').toLowerCase() === 'false' ) {
      return this.showOffline(Number(fields[6]));
    }
    if( this.offline ) {
      this.offline = false;
      this.lastAppliedState = '';   // write the real state again below
      this.log.info('Vacuum is back online');
    }
    const battery = Number(fields[1]);
    const batteryKnown = fields[1] !== undefined && fields[1] !== '' && Number.isInteger(battery) && battery >= 0 && battery <= 100;
    this.currentStatus = fields[0];
    this.isDocked = (fields[2] ?? '').toLowerCase() === 'true';
    this.fault = fields[3] ?? 'None';
    const suction = (fields[4] ?? '').toLowerCase();
    if( batteryKnown ) {
      this.batteryLevel = battery;
    } else {
      this.log.info(`Wyze reported no usable battery level ('${fields[1] ?? ''}'); keeping ${this.batteryLevel}%`);
    }
    this.myLogger(`Status: ${this.currentStatus}, battery ${this.batteryLevel}%, charging ${this.isDocked}, ` +
      `fault ${this.fault}, suction ${suction || 'unknown'}`);

    if( this.roboticVacuum !== undefined && batteryKnown ) {
      await this.roboticVacuum.updateAttribute(PowerSource.Cluster.id, 'batPercentRemaining', this.batteryLevel * 2, this.log);
      let chargeState = PowerSource.BatChargeState.IsNotCharging;
      if( this.batteryLevel === 100 && this.isDocked ) {
        chargeState = PowerSource.BatChargeState.IsAtFullCharge;
      } else if( this.isDocked ) {
        chargeState = PowerSource.BatChargeState.IsCharging;
      }
      await this.roboticVacuum.updateAttribute(PowerSource.Cluster.id, 'batChargeState', chargeState, this.log);
      await this.roboticVacuum.updateAttribute(PowerSource.Cluster.id, 'batChargeLevel', this.batteryChargeLevel(), this.log);
    }

    // Suction level, also when it was changed in the Wyze app.
    const cleanMode = RoboVacMatterbridgeDynamicPlatform.MODE_BY_SUCTION[suction];
    if( this.roboticVacuum !== undefined && cleanMode !== undefined && Date.now() >= this.suctionGraceUntil ) {
      await this.roboticVacuum.updateAttribute(RvcCleanMode.Cluster.id, 'currentMode', cleanMode, this.log);
    }

    /*
     * Show the vacuum's state in the Home app. Every Wyze mode is mapped (see
     * matterStateFor), including runs started outside Home, and Charging vs Docked.
     * A Wyze fault (stuck, dust bin missing, ...) is shown as an error unless the
     * vacuum is back on the dock. The state is only written when it differs from what
     * was last shown, so a command just sent from Home isn't undone by a poll that
     * ran before the vacuum reacted.
     */
    const target = this.matterStateFor(this.currentStatus, this.batteryLevel, this.isDocked);
    const fault = target && !target.onDock ? this.matterErrorFor(this.fault) : undefined;
    const inGrace = Date.now() < this.commandGraceUntil;
    if( target && target.runMode === RoboVacMatterbridgeDynamicPlatform.RUN_DOCK && !inGrace ) {
      this.activeRunMode = RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN;   // the run is over
    }
    if( target && this.roboticVacuum ) {
      // While cleaning, the run mode that started it ("Clean Kitchen"); runs started in
      // the Wyze app show as "Clean".
      const runMode = target.runMode === RoboVacMatterbridgeDynamicPlatform.RUN_DOCK ? target.runMode : this.activeRunMode;
      const opState = fault ? RvcOperationalState.OperationalState.Error : target.opState;
      const key = this.stateKey(runMode, opState) + (fault ? `:${fault.id}` : '');
      if( key !== this.lastAppliedState && !inGrace ) {
        this.lastAppliedState = key;
        this.rememberShownMode(runMode);
        await this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', runMode, this.log);
        if( runMode === RoboVacMatterbridgeDynamicPlatform.RUN_DOCK ) {
          // No run, so no room being cleaned (Matter: null or a listed room).
          await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'currentArea', null, this.log);
        }
        await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState', opState, this.log);
        await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError', fault
          ? { errorStateId: fault.id, errorStateDetails: fault.details }
          : { errorStateId: RvcOperationalState.ErrorState.NoError }, this.log);
        this.log.info(fault
          ? `Vacuum reports a problem: ${fault.details} (${this.fault}, ${this.currentStatus})`
          : `Vacuum is ${target.label} (${this.currentStatus}, battery ${this.batteryLevel}%)`);
      }
    } else if( this.currentStatus !== this.oldStatus ) {
      this.log.info(`Unrecognised vacuum status '${this.currentStatus}'; Home app state left unchanged`);
    }
    this.oldStatus = this.currentStatus;

    this.idleOnDock = target !== undefined && !target.busy && target.runMode === 1 && !fault;

    // Fast checks while cleaning, paused, returning, faulted or just after a Home
    // command; slower while docked (charging, then full).
    if( !target || target.busy || fault || Date.now() < this.commandGraceUntil ) {
      return this.nextCheckIn(this.interval('busyStatusCheckRefreshInterval'));
    } else if( this.batteryLevel < 100 ) {
      return this.nextCheckIn(this.interval('idleStatusCheck2RefreshInterval'));
    }
    return this.nextCheckIn(this.interval('idleStatusCheck1RefreshInterval'));
  }

  private nextCheckIn(seconds : number) : number {
    this.statusRefreshInterval = seconds;
    if( this.statusRefreshInterval !== this.oldRefreshInterval ) {
      this.log.info(`changing statusRefreshInterval from ${this.oldRefreshInterval} to ${this.statusRefreshInterval} seconds.`);
      this.oldRefreshInterval = this.statusRefreshInterval;
    }
    return this.statusRefreshInterval;
  }

  /*
   * The vacuum is offline: say so once in the log and show an error in Home instead of
   * the last state Wyze knew (for example "paused, 12%" while the battery is long dead).
   * Matter has no "offline" state for a robot vacuum, so an error is the closest honest
   * signal. The run mode is left as it was. Checks slow to the long idle interval; the
   * first check that finds it online again writes the real state.
   */
  private async showOffline(since : number) : Promise<number> {
    if( !this.offline ) {
      this.offline = true;
      const when = Number.isFinite(since) && since > 0 ? ` since ${new Date(since * 1000).toLocaleString()}` : '';
      this.log.warn(`Vacuum is offline${when} (battery empty, switched off or out of Wi-Fi range). ` +
        'Home shows an error and commands are not sent until it is back.');
    }
    this.idleOnDock = false;
    const key = 'offline';
    if( this.roboticVacuum && this.lastAppliedState !== key ) {
      this.lastAppliedState = key;
      this.commandGraceUntil = 0;
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState',
        RvcOperationalState.OperationalState.Error, this.log);
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
        { errorStateId: RvcOperationalState.ErrorState.UnableToStartOrResume, errorStateDetails: 'Vacuum is offline' }, this.log);
    }
    return this.nextCheckIn(this.interval('idleStatusCheck1RefreshInterval'));
  }

  // Wyze has not answered several status checks in a row: show an error rather than a
  // state that may be long out of date. The first check that works writes the real one.
  private async showUnreachable() {
    const key = 'unreachable';
    if( this.roboticVacuum && this.lastAppliedState !== key && Date.now() >= this.commandGraceUntil ) {
      this.lastAppliedState = key;
      this.idleOnDock = false;
      this.log.warn(`Wyze has not answered ${this.statusFailures} status checks in a row; Home shows an error until it does`);
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState',
        RvcOperationalState.OperationalState.Error, this.log);
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
        { errorStateId: RvcOperationalState.ErrorState.UnableToCompleteOperation, errorStateDetails: 'Wyze cloud not reachable' },
        this.log);
    }
  }

  /*
   * Before sending a command: when the last check found the vacuum offline, check again
   * (it may have reconnected since) and refuse if it still is. Matterbridge shows the
   * state it expects once the handler returns, so the status loop then puts the
   * offline error back straight away.
   */
  async ensureOnline(what : string) : Promise<boolean> {
    if( !this.offline ) {
      return true;
    }
    await this.getStatus();
    if( !this.offline ) {
      return true;
    }
    this.refuseOffline(what);
    return false;
  }

  refuseOffline(what : string) {
    this.log.info(`${what} not sent: the vacuum is offline`);
    this.showRealStateSoon();
  }

  // Matterbridge shows the state it expects once a handler returns; when nothing was
  // sent, have the next status check (started now) write the real state over it.
  showRealStateSoon() {
    this.commandGraceUntil = 0;
    this.lastAppliedState = '';
    this.pokeStatusLoop = true;
  }

  /***************** Find the vacuum and its rooms **********************/

  // Uses the last robot vacuum on the Wyze account (nickname and MAC).
  async findDevices() {
    const r = await this.py('getVacuumDeviceList.py', []);
    if( !r.ok ) {
      this.log.info(`Could not list Wyze devices: ${r.stderr}`);
      return;
    }
    for( const line of r.stdout.split('\n').filter((l) => l.trim() !== '') ) {
      const sep = line.lastIndexOf(':');   // nickname may contain ':', the MAC doesn't
      this.nickname = line.slice(0, sep);
      this.macAddr = line.slice(sep + 1);
      this.myLogger(`Found vacuum '${this.nickname}' (${this.macAddr})`);
    }
    if( this.macAddr ) {
      this.saveLastVacuum();
    }
  }

  // The vacuum found last time (vacuum.json next to the token cache), for a start while
  // Wyze is unreachable.
  vacuumFile() : string {
    return path.join(path.dirname(this.tokenFile()), 'vacuum.json');
  }

  readLastVacuum() : { nickname : string, mac : string } | undefined {
    try {
      const v = JSON.parse(readFileSync(this.vacuumFile(), 'utf8'));
      return typeof v?.nickname === 'string' && typeof v?.mac === 'string' && v.mac ? { nickname: v.nickname, mac: v.mac } : undefined;
    } catch {
      return undefined;
    }
  }

  saveLastVacuum() {
    const last = this.readLastVacuum();
    if( last?.nickname === this.nickname && last.mac === this.macAddr ) {
      return;
    }
    try {
      mkdirSync(path.dirname(this.vacuumFile()), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.vacuumFile()}.tmp`, JSON.stringify({ nickname: this.nickname, mac: this.macAddr }) + '\n', { mode: 0o600 });
      renameSync(`${this.vacuumFile()}.tmp`, this.vacuumFile());
    } catch (e) {
      this.log.info(`Could not save ${this.vacuumFile()}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Lines of "room<TAB>floor", including one "*Entire Floor*<TAB>floor" per floor.
  async getRoomList() : Promise<boolean> {
    const r = await this.py('getVacuumFloors.py', [this.nickname]);
    this.lastRoomRefresh = Date.now();
    if( !r.ok ) {
      this.log.info(`Could not read the vacuum's rooms: ${r.stderr}`);
      return false;
    }
    this.rooms = r.stdout.split('\n').filter((l) => l.trim() !== '');
    this.roomsLoaded = true;
    this.myLogger(`Rooms: ${this.rooms.join(', ')}`);
    return true;
  }

  // Read the room list again; if it changed in the Wyze app, update Home.
  async refreshRooms() {
    const before = JSON.stringify([this.supportedMaps, this.supportedAreas]);
    if( !(await this.getRoomList()) ) {
      return;
    }
    this.setupSupportedAreas();
    if( JSON.stringify([this.supportedMaps, this.supportedAreas]) === before ) {
      return;
    }
    this.log.info('The room list changed in the Wyze app; updating Home: ' +
      this.supportedAreas.map((a) => a.areaInfo.locationInfo.locationName).join(', '));
    await this.applyRooms(false);
    // Matter fixes the run-mode list when the device starts, so rooms added or renamed
    // in Wyze reach Alexa's "Clean <room>" list at the next plugin restart.
    this.log.notice('The new room list reaches the run modes (Alexa\'s "Clean <room>") when the plugin restarts');
  }

  // Build the areas from this.rooms (unless already built) and send them to Home.
  async applyRooms(build = true) {
    if( build ) {
      this.setupSupportedAreas();
    }
    this.myLogger(`Floors: ${debugStringify(this.supportedMaps)}`);
    if( !this.roboticVacuum || this.supportedAreas.length === 0 ) {
      return;
    }
    // A selection must only name areas that exist; drop rooms that are gone. The current
    // area and selection are cleared first, so no step names an area that isn't listed.
    this.selectedAreas = this.selectedAreas.filter((id) => this.supportedAreas.some((a) => a.areaId === id));
    try {
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'currentArea', null, this.log);
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'selectedAreas', [], this.log);
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'supportedMaps', this.supportedMaps, this.log);
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'supportedAreas', this.supportedAreas, this.log);
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'selectedAreas', [...this.selectedAreas], this.log);
    } catch (e) {
      // A room list Matter refuses must not stop the plugin: Home keeps the previous list.
      this.log.error(`Matter refused the room list from Wyze (${e instanceof Error ? e.message : String(e)}); ` +
        'Home keeps the previous rooms');
    }
  }

  // =========================== Utilities ===================================

  // Run one helper command, e.g. py('getVacuumStatus.py', [nickname]). ok = it succeeded.
  py(script : string, args : string[]) : Promise<PyResult> {
    return this.worker.request(script.replace(/\.py$/, ''), args);
  }

  // "1.0.12 (GitHub release v1.0.12, commit 2f61f6e, built 2026-11-02)" for packages built
  // by the release workflow, which adds build-info.json; "1.0.12 (local build)" otherwise.
  buildInfo() : string {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
    const read = (f : string) => {
      try {
        return JSON.parse(readFileSync(path.join(root, f), 'utf8'));
      } catch {
        return undefined;
      }
    };
    const version = read('package.json')?.version ?? '?';
    const b = read('build-info.json');
    return b?.commit
      ? `${version} (GitHub release ${b.tag}, commit ${String(b.commit).slice(0, 7)}, built ${String(b.built).slice(0, 10)})`
      : `${version} (local build)`;
  }

  // The py_helpers folder shipped with this plugin (dist/../py_helpers).
  helperDir() : string {
    return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'py_helpers');
  }

  tokenFile() : string {
    const configured = String(this.config.tokenFile ?? '').trim();
    if (configured) {
      return configured.startsWith('~/') ? path.join(homedir(), configured.slice(2)) : configured;
    }
    return path.join(homedir(), '.matterbridge', 'wyze-robovac', 'tokens.json');
  }

  /*
   * Wyze vacuum mode (as printed by getVacuumStatus.py, e.g. 'VacuumMode.SWEEPING')
   * -> Matter run mode (1 Idle, 2 Cleaning) and RVC operational state.
   * Mode names come from wyze_sdk.models.devices.vacuums.VacuumMode.
   */
  matterStateFor(status : string, battery : number, onDock : boolean)
    : { runMode : number, opState : number, busy : boolean, onDock : boolean, label : string } | undefined {
    const S = RvcOperationalState.OperationalState;
    switch( status.replace(/^VacuumMode\./, '') ) {
      case 'CLEANING':
      case 'SWEEPING':
      case 'QUICK_MAPPING_MAPPING':
        return { runMode: 2, opState: S.Running, busy: true, onDock: false, label: 'cleaning' };
      case 'PAUSED':
      case 'PAUSE':
      case 'QUICK_MAPPING_PAUSED':
      case 'BREAK_POINT':
        return { runMode: 2, opState: S.Paused, busy: true, onDock: false, label: 'paused' };
      case 'RETURNING_TO_CHARGE':
      case 'FINISHED_RETURNING_TO_CHARGE':
      case 'FULL_FINISH_SWEEPING_ON_WAY_CHARGE':
      case 'QUICK_MAPPING_COMPLETED_RETURNING_TO_CHARGE':
        return { runMode: 1, opState: S.SeekingCharger, busy: true, onDock: false, label: 'returning to the dock' };
      case 'DOCKED_NOT_COMPLETE':
      case 'QUICK_MAPPING_DOCKED_NOT_COMPLETE':
        return { runMode: 2, opState: S.Charging, busy: false, onDock: true, label: 'charging, and will resume cleaning' };
      case 'IDLE':
        return onDock && battery < 100
          ? { runMode: 1, opState: S.Charging, busy: false, onDock: true, label: 'docked and charging' }
          : { runMode: 1, opState: S.Docked, busy: false, onDock: true, label: 'docked' };
      default:
        return undefined;
    }
  }

  /*
   * Wyze fault (wyze_sdk VacuumFaultCode name) -> Matter RVC error state shown in the
   * Home app. 'None' means no fault. An unknown fault is shown as a generic error.
   */
  matterErrorFor(fault : string) : { id : number, details : string } | undefined {
    const E = RvcOperationalState.ErrorState;
    const name = fault.replace(/^VacuumFaultCode\./, '');
    if( name === '' || name === 'None' || name === '0' ) {
      return undefined;
    }
    const table : Record<string, [number, string]> = {
      RADAR_OUT_OF_TIME: [E.NavigationSensorObscured, 'Lidar sensor blocked'],
      WHEEL_LIFT_UP: [E.Stuck, 'Vacuum not on the ground'],
      DUST_BOX_NO_EXIST: [E.DustBinMissing, 'Dust bin not installed'],
      RELOCATE_FAILED: [E.UnableToCompleteOperation, 'Could not find its position on the map'],
      SLOPE_START: [E.UnableToStartOrResume, 'Vacuum not on flat ground'],
      COLLISION_EXCEPTION: [E.Stuck, 'Vacuum stuck'],
      GO_CHARGE_FAILED: [E.FailedToFindChargingDock, 'Could not return to the dock'],
      STOP_POINT_GO_CHARGE_FAILED: [E.FailedToFindChargingDock, 'Could not return to the dock'],
      NAVIGATION_FAILED: [E.UnableToCompleteOperation, 'Mapping failed'],
      GET_OUT_OF_TROUBLE_FAILED: [E.WheelsJammed, 'Wheels stuck'],
      ROBOT_NO_WATER: [E.WaterTankMissing, 'Water tank not installed'],
      ROBOT_NO_MOP: [E.MopCleaningPadMissing, 'Mop not installed'],
      ROBOT_NO_DUSTANDWATER_MOP: [E.WaterTankMissing, 'Water tank and mop not installed'],
      ROBOT_NO_DUSTANDWATER_HURRI: [E.DustBinMissing, '2-in-1 bin, tank and mop not installed'],
      ROBOT_NO_WATER_HURRI: [E.WaterTankMissing, '2-in-1 bin and water tank not installed'],
      ROBOT_IN_VIRTUALWALL: [E.Stuck, 'Stuck in a no-go zone'],
    };
    const hit = table[name];
    return hit ? { id: hit[0], details: hit[1] } : { id: E.UnableToCompleteOperation, details: `Wyze fault ${name}`.slice(0, 64) };
  }

  // OK / low / critically low, as Home shows it. Charging on the dock always counts as OK,
  // so Home doesn't warn about a vacuum that is already recharging.
  batteryChargeLevel() : number {
    const L = PowerSource.BatChargeLevel;
    if( this.isDocked ) {
      return L.Ok;
    }
    if( this.batteryLevel <= RoboVacMatterbridgeDynamicPlatform.BATTERY_CRITICAL ) {
      return L.Critical;
    }
    return this.batteryLevel <= RoboVacMatterbridgeDynamicPlatform.BATTERY_WARNING ? L.Warning : L.Ok;
  }

  // Seconds between status checks from the settings, with the default and the limits the
  // settings screen documents also for values edited by hand (Wyze may ignore requests
  // that come too often).
  static readonly INTERVALS : Record<string, [number, number, number]> = {   // default, min, max
    busyStatusCheckRefreshInterval: [45, 25, 3600],
    idleStatusCheck1RefreshInterval: [300, 300, 3600],
    idleStatusCheck2RefreshInterval: [60, 60, 3600],
  };

  interval(key : string) : number {
    const [def, min, max] = RoboVacMatterbridgeDynamicPlatform.INTERVALS[key];
    const value = Number(this.config[key]);
    return Number.isFinite(value) && value > 0 ? Math.min(Math.max(Math.round(value), min), max) : def;
  }

  stateKey(runMode : number, opState : number) : string {
    return `${runMode}:${opState}`;
  }

  // Detail for troubleshooting: shown when Matterbridge's log level is set to Debug.
  myLogger( line : string ) {
    this.log.debug( line );
  }

  /*
   * Floors -> Matter maps and rooms -> Matter areas, from this.rooms. IDs are kept by
   * name across calls, so a room keeps its ID (and Home its selection) when the list
   * is read again; new rooms and floors get new IDs.
   */
  setupSupportedAreas() {
    const C = RoboVacMatterbridgeDynamicPlatform;
    const maps : typeof this.supportedMaps = [];
    const areas : typeof this.supportedAreas = [];
    const notes : string[] = [];
    this.fullNames.clear();
    for (const room of this.rooms) {
      // Tab-separated, so room and floor names may contain ':'.
      const [roomName, floorName = ''] = room.split('\t');
      let mapId = this.mapIds.get(floorName);
      if( mapId === undefined ) {
        mapId = this.mapIds.size + 1;
        this.mapIds.set(floorName, mapId);
      }
      if( !maps.some((m) => m.mapId === mapId) ) {
        // Matter: map names at most 64 bytes and unique. The full name is kept for Wyze.
        maps.push({ mapId, name: C.uniqueText(floorName, 64, maps.map((m) => m.name)) });
        this.fullNames.set(`map:${mapId}`, floorName);
      }
      const key = `${floorName}\t${roomName}`;
      let areaId = this.areaIds.get(key);
      if( areaId === undefined ) {
        areaId = this.areaIds.size + 1;
        this.areaIds.set(key, areaId);
      }
      // The floor itself is not listed (picking no rooms, or all of them, cleans it), but
      // keeps its ID, so the rooms' IDs, which Home scenes store, are the same as before.
      if( roomName === C.ENTIRE_FLOOR ) {
        continue;
      }
      // Two rooms with the same name on one floor: Matter needs distinct areas, and the
      // vacuum is told rooms by name, so one entry cleans both.
      if( areas.some((a) => a.areaId === areaId) ) {
        notes.push(`'${roomName}' (${floorName})`);
        continue;
      }
      const taken = areas.filter((a) => a.mapId === mapId).map((a) => a.areaInfo.locationInfo.locationName);
      areas.push({
        areaId,
        mapId,
        areaInfo: {
          // Matter: at most 128 bytes, unique on its floor. The full name is kept for Wyze.
          locationInfo: { locationName: C.uniqueText(roomName, 128, taken), floorNumber: maps.findIndex((m) => m.mapId === mapId),
            areaType: null },
          landmarkInfo: null,
        },
      });
      this.fullNames.set(`area:${areaId}`, roomName);
    }
    if( notes.length > 0 ) {
      this.log.info(`Rooms named more than once on a floor are listed once and cleaned together: ${notes.join(', ')}`);
    }
    this.supportedMaps = maps;
    this.supportedAreas = areas;
  }

  // text cut to maxBytes of UTF-8 at a character boundary and, if that is already taken,
  // ended with " (2)", " (3)", ... (Matter wants names on one list to differ).
  static uniqueText(text : string, maxBytes : number, taken : string[]) : string {
    const cut = (t : string, max : number) => {
      let out = '';
      for (const ch of t) {
        if( Buffer.byteLength(out + ch, 'utf8') > max ) {
          break;
        }
        out += ch;
      }
      return out;
    };
    let name = cut(text, maxBytes);
    for (let n = 2; taken.includes(name); n++) {
      const suffix = ` (${n})`;
      name = cut(text, maxBytes - Buffer.byteLength(suffix, 'utf8')) + suffix;
    }
    return name;
  }

  // The names Wyze knows (supportedMaps/supportedAreas hold Matter's shortened ones).
  floorFullName(mapId : number | undefined) : string | undefined {
    return mapId === undefined ? undefined : this.fullNames.get(`map:${mapId}`);
  }

  roomFullName(areaId : number) : string | undefined {
    return this.fullNames.get(`area:${areaId}`);
  }

  /*
   * Run modes for controllers without a room list (Alexa): Dock, Clean (the rooms picked
   * in Home, or the whole floor), then "Clean All" per floor and "Clean <room>" per room,
   * from the areas set up by setupSupportedAreas. A room whose name is on more than one
   * floor, and "Clean All" when there is more than one floor, get the floor in brackets.
   *
   * Numbers and labels are kept per floor/room name in run-modes.json, so a routine that
   * uses "Clean Kitchen" keeps working when rooms are added or reordered in the Wyze app.
   *
   * Matter saves the current run mode across restarts but not the list, and refuses to
   * start the device when the saved mode is not in the new list. So the list also keeps
   * the last mode that may have been shown (run-modes.json "lastShown") and, when the
   * room list could not be read, every saved mode; such modes are offered but only log a
   * warning when chosen. Modes of rooms gone from the Wyze app are dropped otherwise.
   */
  buildRunModes() : { label: string, mode: number, modeTags: { value: number }[] }[] {
    const C = RoboVacMatterbridgeDynamicPlatform;
    const modes = [
      { label: 'Dock', mode: C.RUN_DOCK, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
      { label: 'Clean', mode: C.RUN_CLEAN, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
    ];
    const cleaning = [{ value: RvcRunMode.ModeTag.Cleaning }];
    this.modeTargets.clear();
    const file = this.readRunModeFile();
    const saved = file.modes;
    const kept : Record<string, { mode : number, label : string }> = {};
    const used = new Set(Object.values(saved).map((e) => e.mode));
    const numberFor = (key : string) : number | undefined => {
      if( saved[key] !== undefined ) {
        return saved[key].mode;
      }
      let n = C.FIRST_TARGET_MODE;
      while( used.has(n) && n <= C.MAX_MODE ) {
        n++;
      }
      if( n > C.MAX_MODE ) {
        return undefined;
      }
      used.add(n);
      return n;
    };
    const offer = (key : string, label : string, target : { mapId? : number, areaId? : number, unavailable? : boolean }) => {
      const mode = numberFor(key);
      if( mode === undefined ) {
        this.log.warn(`Too many rooms for run modes; '${label}' is not offered`);
        return;
      }
      // Matter wants distinct modes: a label that is already taken (a room called "All",
      // or two long names cut to the same 64 bytes) gets " (2)", and a number used twice
      // keeps its first room.
      if( modes.some((m) => m.mode === mode) ) {
        this.log.warn(`Run mode '${label}' is not offered: its number ${mode} is already used`);
        return;
      }
      label = C.uniqueText(label, 64, modes.map((m) => m.label));
      modes.push({ label, mode, modeTags: cleaning });
      this.modeTargets.set(mode, { ...target, label });
      kept[key] = { mode, label };
    };
    const floorSuffix = (mapId : number) => ` (${this.floorFullName(mapId) ?? ''})`;
    for (const map of this.supportedMaps) {
      const floor = this.floorFullName(map.mapId) ?? map.name;
      offer(`${floor}\t${C.ENTIRE_FLOOR}`, C.modeText('Clean All' + (this.supportedMaps.length > 1 ? floorSuffix(map.mapId) : '')),
        { mapId: map.mapId });
      for (const area of this.supportedAreas.filter((a) => a.mapId === map.mapId)) {
        const name = this.roomFullName(area.areaId) ?? area.areaInfo.locationInfo.locationName;
        const shared = this.supportedAreas.some((a) => a.mapId !== map.mapId && this.roomFullName(a.areaId) === name);
        offer(`${floor}\t${name}`, C.modeText(`Clean ${name}` + (shared ? floorSuffix(map.mapId) : '')),
          { mapId: map.mapId, areaId: area.areaId });
      }
    }
    // Saved modes that must stay listed although they clean nothing now.
    for (const [key, e] of Object.entries(saved)) {
      if( kept[key] === undefined && (!this.roomsLoaded || e.mode === file.lastShown) ) {
        offer(key, e.label, { unavailable: true });
      }
    }
    this.lastShownMode = file.lastShown;
    this.saveRunModeFile(kept);
    if( this.modeTargets.size > 0 ) {
      this.log.info(`Run modes: ${modes.map((m) => m.label).join(', ')}`);
    }
    if( !this.roomsLoaded && this.modeTargets.size > 0 ) {
      this.log.warn('The room list could not be read from Wyze: the room run modes are listed but do nothing ' +
        'until the plugin is restarted with Wyze reachable');
    }
    return modes;
  }

  // At most 64 bytes of UTF-8 (Matter's limit for a mode label), cut between characters.
  static modeText(text : string) : string {
    let out = '';
    for (const ch of text) {
      if( Buffer.byteLength(out + ch, 'utf8') > 64 ) {
        break;
      }
      out += ch;
    }
    return out;
  }

  // Next to the token cache: ~/.matterbridge/wyze-robovac/run-modes.json by default.
  runModeFile() : string {
    return path.join(path.dirname(this.tokenFile()), 'run-modes.json');
  }

  // { modes: { "floor<TAB>room": { mode, label } }, lastShown }. A file that can't be
  // read gives fresh numbers (with a warning, as Alexa routines then need redoing).
  readRunModeFile() : { modes : Record<string, { mode : number, label : string }>, lastShown : number } {
    const C = RoboVacMatterbridgeDynamicPlatform;
    const out : Record<string, { mode : number, label : string }> = {};
    let text : string;
    try {
      text = readFileSync(this.runModeFile(), 'utf8');
    } catch {
      return { modes: out, lastShown: C.RUN_DOCK };   // first start
    }
    try {
      const data = JSON.parse(text);
      const seen = new Set<number>();   // a number used twice (hand edit) keeps only its first room
      for (const [key, v] of Object.entries(data?.modes ?? {})) {
        const e = (typeof v === 'number' ? { mode: v } : v) as { mode? : unknown, label? : unknown };
        const mode = Number(e?.mode);
        if( Number.isInteger(mode) && mode >= C.FIRST_TARGET_MODE && mode <= C.MAX_MODE && !seen.has(mode) ) {
          const [room = ''] = key.split('\t').slice(-1);
          const fallback = room === C.ENTIRE_FLOOR ? 'Clean All' : `Clean ${room}`;
          out[key] = { mode, label: C.modeText(typeof e.label === 'string' && e.label ? e.label : fallback) };
          seen.add(mode);
        }
      }
      const last = Number(data?.lastShown);
      return { modes: out, lastShown: Number.isInteger(last) ? last : C.RUN_DOCK };
    } catch (e) {
      this.log.warn(`${this.runModeFile()} could not be read (${e instanceof Error ? e.message : String(e)}); ` +
        'run modes are numbered afresh, so Alexa routines that use them may need to be set up again');
      return { modes: out, lastShown: C.RUN_DOCK };
    }
  }

  saveRunModeFile(modes : Record<string, { mode : number, label : string }>, lastShown : number = this.lastShownMode) {
    const file = this.runModeFile();
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify({ modes, lastShown }, null, 2) + '\n');
      renameSync(`${file}.tmp`, file);
      this.savedRunModes = modes;
    } catch (e) {
      this.log.warn(`Could not save ${file} (${e instanceof Error ? e.message : String(e)}); ` +
        'run-mode numbers may change at the next restart');
    }
  }

  // Remember a room/floor mode Matter may now hold as the current run mode, so the next
  // start still lists it (see buildRunModes).
  rememberShownMode(mode : number) {
    if( mode !== this.lastShownMode ) {
      this.lastShownMode = mode;
      this.saveRunModeFile(this.savedRunModes, mode);
    }
  }

  // The current run mode as Matterbridge holds it.
  currentRunMode() : number {
    const state = (this.roboticVacuum as unknown as { state?: { rvcRunMode?: { currentMode?: number } } } | undefined)?.state;
    return Number(state?.rvcRunMode?.currentMode ?? RoboVacMatterbridgeDynamicPlatform.RUN_DOCK);
  }

  modeLabel(mode : number) : string {
    return this.runModes.find((m) => m.mode === mode)?.label ?? `mode ${mode}`;
  }

  areaName(id : number) : string {
    return this.roomFullName(id) ?? `area ${id}`;
  }

  // Start or resume from a Home command without holding the command up: picking the
  // floor and starting takes Wyze 20-30 s, longer than the Home app waits for a reply.
  // target: a floor/room run mode's floor and room; without one, the rooms picked in Home.
  sweepInBackground(target? : RunTarget, mode : number = RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN, resume = false) {
    this.doSweeping(target, mode, resume)
      .catch((e) => this.log.error(`Start/resume failed: ${e instanceof Error ? e.message : String(e)}`));
  }

  // The floor and rooms for a run of the rooms picked in Home. One floor per run: rooms on
  // other floors are left out (and named in a warning). No rooms picked, or every room
  // of the floor: the whole floor, which also covers the space between rooms.
  roomsToClean(picked : number[]) : { mapId : number | undefined, roomIds : number[] } {
    const mapOf = (id : number) => this.supportedAreas.find((a) => a.areaId === id)?.mapId;
    const known = picked.filter((id) => mapOf(id) !== undefined);
    if( known.length === 0 ) {
      this.log.info('No rooms selected; cleaning the entire first floor');
      return { mapId: this.supportedMaps[0]?.mapId, roomIds: [] };
    }
    const mapId = mapOf(known[0]);
    const skipped = known.filter((id) => mapOf(id) !== mapId);
    if( skipped.length > 0 ) {
      const floorName = this.floorFullName(mapId) ?? '';
      this.log.warn('Rooms on more than one floor were selected. The vacuum cleans one floor per run, so only ' +
        `rooms on '${floorName}' are cleaned now; skipped: ${skipped.map((id) => this.areaName(id)).join(', ')}`);
    }
    const roomIds = known.filter((id) => mapOf(id) === mapId);
    const floorRooms = this.supportedAreas.filter((a) => a.mapId === mapId).map((a) => a.areaId);
    if( floorRooms.every((id) => roomIds.includes(id)) ) {
      this.log.info('Every room on the floor is selected; cleaning the entire floor');
      return { mapId, roomIds: [] };
    }
    return { mapId, roomIds };
  }

  // resume: the run mode asked for is the one already shown, so resume a paused run.
  async doSweeping(target? : RunTarget, mode : number = RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN,
    resume = false) {
    // One start at a time: a command repeated while the first is still being sent (Wyze
    // takes 20-30 s) would otherwise switch the floor and start a second run.
    if( this.starting ) {
      this.log.info('A start is already being sent to the vacuum; this one is skipped');
      return;
    }
    this.starting = true;
    try {
      await this.doSweepingNow(target, mode, resume);
    } finally {
      this.starting = false;
    }
  }

  private async doSweepingNow(target : RunTarget | undefined, mode : number, resume : boolean) {
    // Polls during the next steps must not undo the "cleaning" Matterbridge just showed.
    this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
    // Decide between "start a new run" and "resume" on the vacuum's current status,
    // not on the last poll, which can be from before a pause.
    await this.getStatus();
    if( this.offline ) {
      this.refuseOffline('Start cleaning');   // that check just found it offline: no floor switch, no start
      return;
    }
    let ok : boolean;
    let roomIds : number[] = [];
    // resume: a pause is resumed even with rooms just picked in Home (they are for the next run).
    const newRun = (target !== undefined && !resume) || this.currentStatus === 'VacuumMode.IDLE' || (this.newRoomsSelected && !resume);
    if( newRun ) {
      // A floor/room run mode cleans what it names; otherwise the rooms picked in Home.
      const plan = target
        ? { mapId: target.mapId, roomIds: target.areaId !== undefined ? [target.areaId] : [] }
        : this.roomsToClean(this.selectedAreas);
      if( target ) {
        this.log.info(`Run mode '${target.label}'`);
      }
      roomIds = plan.roomIds;
      this.newRoomsSelected = false;
      await this.setFloor(plan.mapId);
      ok = await this.startSweeping(roomIds);
    } else {
      ok = await this.startCleaning();   // Resume cleaning after a pause
    }
    if( !ok ) {
      return;   // afterCommand has the status loop show the real state
    }
    if( newRun ) {
      this.activeRunMode = mode;   // not a resume: show this run's mode while it lasts
    }
    if( this.roboticVacuum ) {
      this.rememberShownMode(this.activeRunMode);
      await this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', this.activeRunMode, this.log);
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState',
        RvcOperationalState.OperationalState.Running, this.log);
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
        { errorStateId: RvcOperationalState.ErrorState.NoError }, this.log);
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'currentArea', roomIds[0] ?? null, this.log);
      this.lastAppliedState = this.stateKey(this.activeRunMode, RvcOperationalState.OperationalState.Running);
    }
    // Check the vacuum's status now and then on the fast interval. (The original
    // version waited here in a loop that could spin without pausing, freezing the
    // plugin, whenever another handler asked for an early status check.)
    this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
    this.pokeStatusLoop = true;
  }

  async startStatusLoop() {
    while( !this.stopping ) {
      this.pokeStatusLoop = false;
      let refreshInterval = 60;
      try {
        refreshInterval = Number(await this.getStatus()) || 60;   // 60 s if the settings are unusable
        const sinceRooms = Date.now() - this.lastRoomRefresh;
        if( (this.idleOnDock && sinceRooms >= RoboVacMatterbridgeDynamicPlatform.ROOM_REFRESH_MS)
            || (!this.roomsLoaded && this.statusFailures === 0 && sinceRooms >= RoboVacMatterbridgeDynamicPlatform.ROOM_RETRY_MS) ) {
          await this.refreshRooms();   // also: the room list couldn't be read at startup
        }
      } catch (e) {
        // For example Matterbridge refusing an attribute value: log it and keep polling,
        // rather than leaving Home with a state that never updates again.
        this.log.error(`Status check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      this.myLogger(`Next status check in ${refreshInterval} s`);
      for( let i = 0; i < refreshInterval && !this.pokeStatusLoop && !this.stopping; i++ ) {
        await setTimeout(1000);   // a command or shutdown ends the wait early
      }
    }
    this.myLogger('Status loop stopped');
  }
}
