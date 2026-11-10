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
  private lastRoomRefresh = 0;
  private idleOnDock = false;   // last status check: docked, idle and no fault
  private isDocked = true;
  private fault : string = 'None';   // Wyze fault name from the last status check, e.g. 'COLLISION_EXCEPTION'
  private offline = false;   // Wyze says the vacuum is not connected (battery dead, switched off, out of Wi-Fi)
  private newRoomsSelected : boolean = false;

  // The run modes offered at startup (Matter does not allow the list to change while
  // running), what each floor/room mode cleans, and the mode the current run used.
  private runModes : { label: string, mode: number, modeTags: { value: number }[] }[] = [];
  private readonly modeTargets = new Map<number, { mapId: number, areaId?: number, label: string }>();
  private activeRunMode : number = RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN;

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
        await setTimeout(30_000);
      }
      await this.findDevices();
    }
    if( !this.macAddr ) {
      this.log.error('No Wyze robot vacuum found on the account (see the messages above). ' +
        'Fix the settings or the connection, then restart the plugin.');
      return;
    }

    await this.getRoomList();
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
      1, // currentArea
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
    this.roboticVacuum.addCommandHandler('pause', async () => {
      this.log.info('\'pause\' handler called - RoboVac');
      if( await this.pauseSweeping() ) {
        this.lastAppliedState = this.stateKey(2, RvcOperationalState.OperationalState.Paused);
        this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
        this.pokeStatusLoop = true;
      }
    });

    this.roboticVacuum.addCommandHandler('resume', async () => {
      this.log.info('\'resume\' handler called - RoboVac');
      this.sweepInBackground();
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
      if( mode === current ) {
        return;   // already doing this; Matterbridge answers "already in requested mode"
      }
      if( target.areaId !== undefined && !this.supportedAreas.some((a) => a.areaId === target.areaId) ) {
        this.log.warn(`'${target.label}' not started: that room is no longer in the Wyze app. ` +
          'Restart the plugin to update the list of run modes.');
        return;
      }
      this.sweepInBackground(target, mode);
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
    const floorName = this.supportedMaps.find((m) => m.mapId === mapId)?.name;
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
      .map((id) => this.supportedAreas.find((a) => a.areaId === id)?.areaInfo.locationInfo.locationName)
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
      return this.statusRefreshInterval || this.interval('busyStatusCheckRefreshInterval');
    }
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
        await this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', runMode, this.log);
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
    // A selection must only name areas that exist; drop rooms that are gone.
    this.selectedAreas = this.selectedAreas.filter((id) => this.supportedAreas.some((a) => a.areaId === id));
    await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'selectedAreas', [...this.selectedAreas], this.log);
    await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'supportedMaps', this.supportedMaps, this.log);
    await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'supportedAreas', this.supportedAreas, this.log);
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
    const maps : typeof this.supportedMaps = [];
    const areas : typeof this.supportedAreas = [];
    for (const room of this.rooms) {
      // Tab-separated, so room and floor names may contain ':'.
      const [roomName, floorName = ''] = room.split('\t');
      let mapId = this.mapIds.get(floorName);
      if( mapId === undefined ) {
        mapId = this.mapIds.size + 1;
        this.mapIds.set(floorName, mapId);
      }
      if( !maps.some((m) => m.mapId === mapId) ) {
        maps.push({ mapId, name: floorName });
      }
      if( roomName === RoboVacMatterbridgeDynamicPlatform.ENTIRE_FLOOR ) {
        continue;   // the floor itself: picking no rooms (or all of them) cleans it
      }
      const key = `${floorName}\t${roomName}`;
      let areaId = this.areaIds.get(key);
      if( areaId === undefined ) {
        areaId = this.areaIds.size + 1;
        this.areaIds.set(key, areaId);
      }
      areas.push({
        areaId,
        mapId,
        areaInfo: {
          locationInfo: { locationName: roomName, floorNumber: maps.findIndex((m) => m.mapId === mapId), areaType: null },
          landmarkInfo: null,
        },
      });
    }
    this.supportedMaps = maps;
    this.supportedAreas = areas;
  }

  /*
   * Run modes for controllers without a room list (Alexa): Dock, Clean (the rooms picked
   * in Home, or the whole floor), then "Clean All" per floor and "Clean <room>" per room,
   * from the areas set up by setupSupportedAreas. A room whose name is on more than one
   * floor, and "Clean All" when there is more than one floor, get the floor in brackets.
   * Numbers are kept per floor/room name in run-modes.json, so a routine that uses
   * "Clean Kitchen" keeps working when rooms are added or reordered in the Wyze app.
   */
  buildRunModes() : { label: string, mode: number, modeTags: { value: number }[] }[] {
    const C = RoboVacMatterbridgeDynamicPlatform;
    const modes = [
      { label: 'Dock', mode: C.RUN_DOCK, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
      { label: 'Clean', mode: C.RUN_CLEAN, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
    ];
    this.modeTargets.clear();
    const saved = this.readRunModeNumbers();
    const used = new Set(Object.values(saved));
    const numberFor = (key : string) : number | undefined => {
      if( saved[key] === undefined ) {
        let n = C.FIRST_TARGET_MODE;
        while( used.has(n) && n <= C.MAX_MODE ) {
          n++;
        }
        if( n > C.MAX_MODE ) {
          return undefined;
        }
        saved[key] = n;
        used.add(n);
      }
      return saved[key];
    };
    const floorSuffix = (mapId : number) => ` (${this.supportedMaps.find((m) => m.mapId === mapId)?.name ?? ''})`;
    const label = (text : string) => text.slice(0, 64);   // Matter's limit for a mode label
    for (const map of this.supportedMaps) {
      const targets : { key : string, label : string, areaId? : number }[] = [{
        key: `${map.name}\t${C.ENTIRE_FLOOR}`,
        label: label('Clean All' + (this.supportedMaps.length > 1 ? floorSuffix(map.mapId) : '')),
      }];
      for (const area of this.supportedAreas.filter((a) => a.mapId === map.mapId)) {
        const name = area.areaInfo.locationInfo.locationName;
        const shared = this.supportedAreas.some((a) => a.mapId !== map.mapId && a.areaInfo.locationInfo.locationName === name);
        targets.push({ key: `${map.name}\t${name}`, label: label(`Clean ${name}` + (shared ? floorSuffix(map.mapId) : '')),
          areaId: area.areaId });
      }
      for (const t of targets) {
        const mode = numberFor(t.key);
        if( mode === undefined ) {
          this.log.warn(`Too many rooms for run modes; '${t.label}' is not offered`);
          continue;
        }
        // Two rooms with the same name on one floor (or a room called "All"): Matter
        // needs distinct modes, so only the first is offered; Home's room list has both.
        if( modes.some((m) => m.mode === mode || m.label === t.label) ) {
          this.log.warn(`Run mode '${t.label}' is offered only once; rename the duplicate room in the Wyze app to get both`);
          continue;
        }
        modes.push({ label: t.label, mode, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] });
        this.modeTargets.set(mode, { mapId: map.mapId, areaId: t.areaId, label: t.label });
      }
    }
    this.saveRunModeNumbers(saved);
    if( this.modeTargets.size > 0 ) {
      this.log.info(`Run modes: ${modes.map((m) => m.label).join(', ')}`);
    }
    return modes;
  }

  // Next to the token cache: ~/.matterbridge/wyze-robovac/run-modes.json by default.
  runModeFile() : string {
    return path.join(path.dirname(this.tokenFile()), 'run-modes.json');
  }

  readRunModeNumbers() : Record<string, number> {
    try {
      const data = JSON.parse(readFileSync(this.runModeFile(), 'utf8'));
      const out : Record<string, number> = {};
      const seen = new Set<number>();   // a number used twice (hand edit) keeps only its first room
      for (const [k, v] of Object.entries(data?.modes ?? {})) {
        if( Number.isInteger(v) && Number(v) >= RoboVacMatterbridgeDynamicPlatform.FIRST_TARGET_MODE
            && Number(v) <= RoboVacMatterbridgeDynamicPlatform.MAX_MODE && !seen.has(Number(v)) ) {
          out[k] = Number(v);
          seen.add(Number(v));
        }
      }
      return out;
    } catch {
      return {};   // first start, or an unreadable file: numbers are handed out afresh
    }
  }

  saveRunModeNumbers(modes : Record<string, number>) {
    const file = this.runModeFile();
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(`${file}.tmp`, JSON.stringify({ modes }, null, 2) + '\n');
      renameSync(`${file}.tmp`, file);
    } catch (e) {
      this.log.info(`Could not save the run-mode numbers (${e instanceof Error ? e.message : String(e)}); ` +
        'they may change at the next restart');
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
    return this.supportedAreas.find((a) => a.areaId === id)?.areaInfo.locationInfo.locationName ?? `area ${id}`;
  }

  // Start or resume from a Home command without holding the command up: picking the
  // floor and starting takes Wyze 20-30 s, longer than the Home app waits for a reply.
  // target: a floor/room run mode's floor and room; without one, the rooms picked in Home.
  sweepInBackground(target? : { mapId : number, areaId? : number, label : string },
    mode : number = RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN) {
    this.doSweeping(target, mode).catch((e) => this.log.error(`Start/resume failed: ${e instanceof Error ? e.message : String(e)}`));
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
      const floorName = this.supportedMaps.find((m) => m.mapId === mapId)?.name ?? '';
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

  async doSweeping(target? : { mapId : number, areaId? : number, label : string },
    mode : number = RoboVacMatterbridgeDynamicPlatform.RUN_CLEAN) {
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
    const newRun = target !== undefined || this.currentStatus === 'VacuumMode.IDLE' || this.newRoomsSelected;
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
        if( this.idleOnDock && Date.now() - this.lastRoomRefresh >= RoboVacMatterbridgeDynamicPlatform.ROOM_REFRESH_MS ) {
          await this.refreshRooms();
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
