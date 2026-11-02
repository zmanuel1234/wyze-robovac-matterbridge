/**
 * This file contains the class RoboVacMatterbridgeDynamicPlatform.
 *
 * @file platform.ts
 * @author Rob Coben
 * @version 0.0.5
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
// import { isValidBoolean, isValidNumber } from 'matterbridge/utils';
import { AnsiLogger, debugStringify } from 'matterbridge/logger';
// import { BooleanState, OnOff, LevelControl, } from 'matterbridge/matter/clusters';
import { RvcRunMode, PowerSource, ServiceArea, RvcOperationalState, RvcCleanMode } from 'matterbridge/matter/clusters';
import { execFile, ExecFileException } from 'child_process';
import { homedir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { setTimeout } from 'timers/promises';
// import { BasicInformationServer, BridgedDeviceBasicInformationServer } from 'matterbridge/matter/behaviors';


export class RoboVacMatterbridgeDynamicPlatform extends MatterbridgeDynamicPlatform {

  // Matter clean-mode number -> Wyze suction level understood by vacuumSetSuction.py
  // How long after a Home command the vacuum gets to react (Wyze takes 10-15 s)
  // before a poll that still shows the old state may overwrite what Home displays.
  static readonly COMMAND_GRACE_MS = 40_000;

  static readonly SUCTION_BY_MODE : Record<number, string> = { 1: 'standard', 3: 'quiet', 4: 'strong' };

  private discoverDevicesFinished = false;
  private getCurrentStatusFinished = false;
  private getRoomsFinished = false;
  private startSweepFinished = false;
  private startCleanFinished = false;
  private stopSweepFinished = false;
  private pauseSweepFinished = false;
  private continueSweepFinished = false;
  private setFloorFinished = false;

  private nickname : string = 'RoboVac';
  private macAddr : string = '';
  private currentStatus : string = '';
  private oldStatus : string = '';
  private lastAppliedState : string = '';   // run mode + operational state last shown in the Home app
  private commandGraceUntil : number = 0;   // until then, polls don't overwrite a state set by a Home command
  private currentFloorName : string = '';
  private batteryLevel : number = 0;
  private batteryWasCharging : boolean = false;
  private rooms: string[] = [];
  private supportedMaps : { mapId: number; name: string; }[] = [];
  private supportedAreas: { areaId: number, mapId: number,
                            areaInfo: { locationInfo: { locationName: string, floorNumber: number, areaType: null },
                                        landmarkInfo: null } }[] = [];

  private selectedAreas : number[] = [];
  private currentMapId : number = -1;
  private isDocked = true;
  private errorCode : string = 'None';
  private newRoomsSelected : boolean = false;

  private pokeStatusLoop : boolean = false;
  private statusRefreshInterval : number = 0;
  private oldRefreshInterval : number = 0;

  private roboticVacuum: MatterbridgeEndpoint | undefined;

  bridgedDevices = new Map<string, MatterbridgeEndpoint>();

  // The type Matterbridge passes in was renamed across 3.x releases; take it from the base class.
  constructor(matterbridge: ConstructorParameters<typeof MatterbridgeDynamicPlatform>[0], log: AnsiLogger, config: PlatformConfig) {
    super(matterbridge, log, config);

    // Verify that Matterbridge is the correct version
    if (this.verifyMatterbridgeVersion === undefined || typeof this.verifyMatterbridgeVersion !== 'function'
                                                     || !this.verifyMatterbridgeVersion('3.3.3')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.3.3".
         Please update Matterbridge from ${this.matterbridge.matterbridgeVersion}
         to the latest version in the frontend.`,
      );
    }

    this.log.info('Initializing platform:', this.config.name);
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
    // 'mfaCode' was never used; 2FA now works through 'totpKey'.
    if (config.mfaCode !== undefined) {
      delete config.mfaCode;
    }
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

    await this.findDevices();   // Get nickname for vacuum
    this.myLogger(`After findDevices(), this.nickname = '${this.nickname}'`);

    await this.getRoomList();

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
      1, // currentRunMode
      [
        { label: 'Idle', mode: 1, modeTags: [{ value: RvcRunMode.ModeTag.Idle }] },
        { label: 'Cleaning', mode: 2, modeTags: [{ value: RvcRunMode.ModeTag.Cleaning }] },
      ], // supportedRunModes
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
          areaInfo: { locationInfo: { locationName: 'Living', floorNumber: 0, areaType: null },
            landmarkInfo: null },
        },
      ], // supportedAreas
      [], // selectedAreas
      1, // currentArea
      [
        {
          mapId: 1,
          name: 'Ground floor',
        },
      ], // supportedMaps
    );

    //   createDefaultBridgedDeviceBasicInformationClusterServer(this.nickname, this.macAddr, 0xfff1, 'Wyze', 'MyToy');

    if (this.config.enableServerRvc === true) {
      this.log.notice('RVC is in server mode 66');
    }

    this.roboticVacuum.addCommandHandler('pause', async () => {
      this.log.info('\'pause\' handler called - RoboVac');
      await this.pauseSweeping();
      this.lastAppliedState = this.stateKey(2, RvcOperationalState.OperationalState.Paused);
      this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
      this.pokeStatusLoop = true;
    });

    this.roboticVacuum.addCommandHandler('resume', async () => {
      this.log.info('\'resume\' handler called - RoboVac');
      this.doSweeping();
    });

    // Returns as soon as the dock command is sent: Matterbridge shows "returning to dock"
    // in the Home app once this handler returns, and the status loop tracks the rest.
    // (The original version waited here until the vacuum had docked, which held the
    // Home app's command, and the tile, for minutes.)
    this.roboticVacuum.addCommandHandler('goHome', async () => {
      this.log.info('\'goHome\' handler called - RoboVac');
      await this.stopSweeping();
      // Matterbridge sets "returning to dock" itself but leaves the run mode alone, so
      // forget what was shown: the first check after the grace period writes both.
      this.lastAppliedState = '';
      this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
      this.pokeStatusLoop = true;
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

    this.roboticVacuum.addCommandHandler('changeToMode', async ({ request }) => {
      this.myLogger(`'changeToMode' handler called - RoboVac. New mode = ${request.newMode}`); // 1 == Idle, 2 == Running
      if( request.newMode === 2 ) { // Start vacuuming or Resume if paused
        this.doSweeping();
      }
    });

    // Matterbridge 3.11+ calls this exact name for clean-mode changes (it only
    // reaches it while the vacuum is idle). Maps the mode to a Wyze suction level.
    this.roboticVacuum.addCommandHandler('RvcCleanMode.changeToMode', async ({ request }) => {
      const level = RoboVacMatterbridgeDynamicPlatform.SUCTION_BY_MODE[request.newMode];
      if( level === undefined ) {
        this.log.info(`Unknown clean mode ${request.newMode}; suction left unchanged`);
        return;
      }
      this.log.info(`Setting suction level to ${level}`);
      this.runPy('vacuumSetSuction.py', [this.nickname, level], (error, _stdout, stderr) => {
        if( error || stderr ) {
          this.log.info(`Could not set suction level: ${(stderr || error?.message || '').trim()}`);
        }
      });
    });

    this.myLogger('before addDevice');
    this.roboticVacuum = await this.addDevice(this.roboticVacuum);
    /*
    if( this.roboticVacuum ) {
      this.roboticVacuum.createDefaultBasicInformationClusterServer(this.nickname,
        this.macAddr, 0xfff1, 'Wyze', 0x8000, 'Robot Vacuum Cleaner');
    }
*/

    this.setupSupportedAreas();   // rooms & floors as defined in the Wyze app.
    this.myLogger('after setupSupportedAreas');
    this.myLogger('debugStringify( this.supportedMaps ):');
    this.myLogger( debugStringify( this.supportedMaps));
    if( this.roboticVacuum ) {
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'supportedMaps', this.supportedMaps, this.log);
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'supportedAreas', this.supportedAreas, this.log);
    }

    this.pokeStatusLoop = false;
    this.startStatusLoop();
  }

  override async onConfigure() {
    await super.onConfigure();
    this.myLogger('onConfigure called - RoboVac');
    if( this.roboticVacuum ) {
      await this.roboticVacuum.setAttribute('BridgedDeviceBasicInformation', 'vendorName', 'RobsToy', this.log);
    }
    await this.getStatus();
  }

  override async onShutdown(reason?: string) {
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
      this.bridgedDevices.set(device.deviceName, device);
      return device;
    } else {
      return undefined;
    }
  }

  // ========================= Wyze API interface `=============================================

  /***************** SetFloor **********************/

  async setFloor() {
    /*
     * Find the floor name
     */
    if( this.selectedAreas.length === 0 ) {
      this.currentMapId = 1;
    } else {               // All selected rooms will be on the same floor so use the first one.
      for (let j = 0; j < this.supportedAreas.length; j++) {
        if( this.selectedAreas[0] === this.supportedAreas[j].areaId ) {
          this.currentMapId = this.supportedAreas[j].mapId;
        }
      }
    }
    for (let i = 0; i < this.supportedMaps.length; i++) {
      if( this.currentMapId === this.supportedMaps[i].mapId) {
        this.currentFloorName = this.supportedMaps[i].name;
        this.myLogger(` in setFloor(): this.currentFloorName = '${this.currentFloorName}'`);
      }
    }
    /*
     * Change map in the Wyze app to the current floor
     */
    let cntr = 0;
    this.setFloorFinished = false;
    await this.setCurrentFloor( this.currentFloorName );
    this.myLogger('waiting for setCurrentFloor() to finish');
    while( ! this.setFloorFinished ) {
      if( cntr++ > 10 ) {  // Wait up to 10 seconds for getCurrentStatus() to finish
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`SCF cntr = '${cntr}'`);
    }
    this.myLogger( 'at end of setCurrentFloor()' );
  }

  async setCurrentFloor( floorName : string ) {
    const floor = floorName;
    this.runPy('setVacuumFloor.py', [this.nickname, floor],
      (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
        }
        if (stderr) {
          this.log.info(`stderr: ${stderr}`);
        }

        if (error || stderr) {
          this.setFloorFinished = true;
          return;
        }
        this.myLogger(`Current map set to floor '${floor}'`);
      },
    );
    this.setFloorFinished = true;
    return;
  }

  /***************** Clean **********************/

  async startCleaning() {          // This should only be called when resuming after a 'Pause'
    let cntr = 0;
    this.startCleanFinished = false;
    await this.vacuumStartClean( this.nickname );
    this.myLogger('waiting for vacuumStartClean() to finish');
    while( ! this.startCleanFinished ) {
      if( cntr++ > 10 ) {  // Wait up to 10 seconds for vacuumStartClean() to finish
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`SS cntr = '${cntr}'`);
    }
    this.myLogger( 'at end of pauseSweeping()' );
  }

  async vacuumStartClean(nickname : string) {
    this.runPy('vacuumStartClean.py', [nickname],
      (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
          this.startCleanFinished = true;
          return;
        }
        if (stderr) {
          this.myLogger(`stderr: ${stderr}`);
          if( stderr.toLowerCase().includes('robovac is docked') ) {
            if( this.roboticVacuum ) {
              this.log.info('Wanted to Resume cleaning but device is currently docked. Update the UI');
              this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', 1, this.log); // Idle
              this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState',
                RvcOperationalState.OperationalState.Docked, this.log);
              this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
                { errorStateId: RvcOperationalState.ErrorState.NoError }, this.log);
            }
          }
          this.startCleanFinished = true;
          return;
        }

        this.startCleanFinished = true;
        return;
      });
  }

  /***************** Pause **********************/

  async pauseSweeping() {
    let cntr = 0;
    this.pauseSweepFinished = false;
    await this.vacuumPauseSweeping( this.nickname );
    this.myLogger('waiting for vacuumPauseSweeping() to finish');
    while( ! this.pauseSweepFinished ) {
      if( cntr++ > 10 ) {  // Wait up to 10 seconds for vacuumPauseSweeping() to finish
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`SS cntr = '${cntr}'`);
    }
    this.myLogger('at end of pauseSweeping()' );
  }

  async vacuumPauseSweeping(nickname : string) {
    this.runPy('vacuumPauseSweep.py', [nickname],
      (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
          this.pauseSweepFinished = true;
          return;
        }
        if (stderr) {
          this.myLogger(`stderr: ${stderr}`);
          if( stderr.toLowerCase().includes('robovac is docked') ) {
            if( this.roboticVacuum ) {
              this.log.info('Wanted to Pause but device is currently docked. Update the UI');
              this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', 1, this.log); // Idle
              this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState',
                RvcOperationalState.OperationalState.Docked, this.log);
              this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
                { errorStateId: RvcOperationalState.ErrorState.NoError }, this.log);
            }
          }
          this.pauseSweepFinished = true;
          return;
        }

        this.pauseSweepFinished = true;
        return;
      });
  }

  /***************** StopSweep **********************/

  async stopSweeping() {
    let cntr = 0;
    this.stopSweepFinished = false;
    await this.vacuumStopSweeping( this.nickname );
    this.myLogger('waiting for vacuumStopSweeping() to finish');
    while( ! this.stopSweepFinished ) {
      if( cntr++ > 10 ) {  // Wait up to 10 seconds for vacuumStopSweeping() to finish
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`SS cntr = '${cntr}'`);
    }
    this.myLogger('at end of stopSweeping()' );
  }

  async vacuumStopSweeping(nickname : string) {
    this.runPy('vacuumStopSweep.py', [nickname],
      (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
          this.stopSweepFinished = true;
          return;
        }
        if (stderr) {
          this.myLogger(`stderr: ${stderr}`);
          if( stderr.toLowerCase().includes('robovac is already docked') ) {
            if( this.roboticVacuum ) {
              this.log.info('Wanted to Stop sweeping but device is already docked. Update the UI');
              this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', 1, this.log); // Idle
              this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState',
                RvcOperationalState.OperationalState.Docked, this.log);
              this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
                { errorStateId: RvcOperationalState.ErrorState.NoError }, this.log);
            }
          }

          this.stopSweepFinished = true;
          return;
        }

        this.stopSweepFinished = true;
        return;
      });
  }

  /***************** StartSweep **********************/

  async startSweeping() {
    let cntr = 0;
    this.startSweepFinished = false;
    await this.vacuumStartSweeping( this.nickname, this.selectedAreas );
    this.myLogger('waiting for vacuumStartSweeping() to finish');
    while( ! this.startSweepFinished ) {
      if( cntr++ > 10 ) {  // Wait up to 10 seconds for vacuumStartSweeping() to finish
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`VSS cntr = '${cntr}'`);
    }
    this.myLogger( 'at end of startSweeping()' );
  }

  async vacuumStartSweeping(nickname : string, rooms2sweep : number[]) {
    const roomNames : string[] = [];
    if( rooms2sweep.length > 0 ) {
      for (let i = 0; i < rooms2sweep.length; i++) {
        const areaId = rooms2sweep[i];
        this.myLogger(`before StartSweep, rooms2sweep[${i}] = '${areaId}'`);
        for (let j = 0; j < this.supportedAreas.length; j++) {
          const area = this.supportedAreas[j];
          if( area.areaId === areaId ) {
            const name : string = area.areaInfo.locationInfo.locationName;
            roomNames.push( name );
            this.myLogger(`roomNames = '${roomNames.join(', ')}'`);
          }
        }
      }
      this.log.info(`Rooms to be swept = '${roomNames.join(', ')}'`);
    }
    this.runPy('vacuumStartSweep.py', [nickname, ...roomNames],
      (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
          this.startSweepFinished = true;
          return;
        }
        if (stderr) {
          this.log.info(`stderr: ${stderr}`);
          this.startSweepFinished = true;
          return;
        }

        this.myLogger(`in startSweeping(): rooms2sweep = '${rooms2sweep}'`);

        this.startSweepFinished = true;
        return;
      });
  }

  /***************** Status **********************/
  async getStatus() {
    let cntr = 0;
    this.getCurrentStatusFinished = false;
    await this.getCurrentStatus(this.nickname);
    this.myLogger('waiting for getCurrentStatus() to finish');
    while( ! this.getCurrentStatusFinished ) {
      if( cntr++ > 10 ) {  // Wait up to 10 seconds for getCurrentStatus() to finish
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`GCS cntr = '${cntr}'`);
    }
    this.myLogger(`at end of getStatus(), this.currentStatus = '${this.currentStatus}'`);
    return this.statusRefreshInterval;
  }

  async getCurrentStatus(nickname : string) {
    this.currentStatus = '';
    this.runPy('getVacuumStatus.py', [nickname],
      async (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
          this.getCurrentStatusFinished = true;
          return;
        }
        if (stderr) {
          this.log.info(`stderr: ${stderr}`);
          this.getCurrentStatusFinished = true;
          return;
        }
        const line = stdout.slice(0, -1);  // Strip off trailing newline ('\n')
        this.myLogger(`Current status = '${line}'`);
        const fields = line.split( ':' );
        this.currentStatus = fields[0];
        this.batteryLevel = Number(fields[1]);
        this.isDocked = fields[2].toLowerCase() === 'true';
        this.errorCode = fields[3];
        this.myLogger(`in getCurrentStatus(): currentStatus = '${this.currentStatus}', batteryLevel = ${this.batteryLevel},
                      isDocked = ${this.isDocked}, errorCode = '${this.errorCode}'`);
        if( this.roboticVacuum !== undefined ) {
          /*
           *  Update battery status in UI
           */
          this.roboticVacuum.updateAttribute(PowerSource.Cluster.id, 'batPercentRemaining', this.batteryLevel * 2, this.log);
          if( this.batteryLevel === 100 ) {
            this.roboticVacuum.updateAttribute(PowerSource.Cluster.id, 'batChargeState',
              PowerSource.BatChargeState.IsAtFullCharge, this.log);
            if( this.batteryWasCharging ) {
              this.batteryWasCharging = false;
              this.pokeStatusLoop = true;
            }
          } else {
            if( this.isDocked ) {
              this.roboticVacuum.updateAttribute(PowerSource.Cluster.id, 'batChargeState',
                PowerSource.BatChargeState.IsCharging, this.log);
              this.batteryWasCharging = true;
            } else {
              this.roboticVacuum.updateAttribute(PowerSource.Cluster.id, 'batChargeState',
                PowerSource.BatChargeState.IsNotCharging, this.log);
              this.batteryWasCharging = false;
            }
          }
        }
        /*
         * Show the vacuum's state in the Home app. Every Wyze mode is mapped (see
         * matterStateFor), including runs started outside Home, and Charging vs Docked.
         * The state is only written when it changes from what was last shown, so a
         * command just sent from Home isn't undone by a poll that ran before the
         * vacuum reacted.
         */
        const target = this.matterStateFor(this.currentStatus, this.batteryLevel, this.isDocked);
        if( target && this.roboticVacuum ) {
          const key = this.stateKey(target.runMode, target.opState);
          const inGrace = Date.now() < this.commandGraceUntil;
          if( key !== this.lastAppliedState && !inGrace ) {
            this.lastAppliedState = key;
            await this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', target.runMode, this.log);
            await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState', target.opState, this.log);
            await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
              { errorStateId: RvcOperationalState.ErrorState.NoError }, this.log);
            this.log.info(`Vacuum is ${target.label} (${this.currentStatus}, battery ${this.batteryLevel}%)`);
          }
        } else if( this.currentStatus !== this.oldStatus ) {
          this.log.info(`Unrecognised vacuum status '${this.currentStatus}'; Home app state left unchanged`);
        }
        this.oldStatus = this.currentStatus;
        /*
         * Determine statusRefreshInterval: fast while cleaning, pausing or returning
         * (or when the state is unknown), slower while docked.
         */
        if( !target || target.busy || Date.now() < this.commandGraceUntil ) {
          this.statusRefreshInterval = Number( this.config.busyStatusCheckRefreshInterval );  // Active
        } else if( this.batteryLevel < 100 ) {
          this.statusRefreshInterval = Number( this.config.idleStatusCheck2RefreshInterval );  // Docked battery < 100% charge
        } else {
          this.statusRefreshInterval = Number( this.config.idleStatusCheck1RefreshInterval );  // Docked battery full charge
        }

        if( this.statusRefreshInterval !== this.oldRefreshInterval ) {
          this.log.info(`changing statusRefreshIinterval from ${this.oldRefreshInterval} to ${this.statusRefreshInterval} seconds.`);
          this.oldRefreshInterval = this.statusRefreshInterval;
        }
        this.getCurrentStatusFinished = true;
        return this.statusRefreshInterval;
      });
  }

  /***************** Find Devices **********************/

  async findDevices() {
    let cntr = 0;
    this.discoverDevicesFinished = false;
    await this.discoverDevices();
    this.myLogger('waiting for discoverDevices() to finish');
    while( ! this.discoverDevicesFinished ) {
      if( cntr++ > 45 ) {  // Wait up to 45 seconds (a first login with 2FA can take a while)
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`DD cntr = '${cntr}'`);
    }
  }

  async discoverDevices() {
    const nickNames : string[] = [];
    const macAddrs : string[] = [];
    this.nickname = ''
    //
    // Make list of nicknames for each vacuum.
    //
    this.myLogger('Before exec getVacuumDeviceList.py');
    this.runPy('getVacuumDeviceList.py', [],
      (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
          this.discoverDevicesFinished = true;
          return;
        }
        if (stderr) {
          this.log.info(`stderr: ${stderr}`);
          this.discoverDevicesFinished = true;
          return;
        }
        let line = '';

        // Get individual lines of output from stdout
        for(let i = 0; i < stdout.length; i++) {
          const c = stdout.charAt(i);
          if( c === '\n') {
            const fields = line.split(':');
            nickNames.push( fields[0] );
            macAddrs.push( fields[1] );
            line = '';
            continue;
          }
          line = line.concat( stdout.charAt(i) );
        }

        // loop over the discovered devices.
        this.myLogger(`nickNames.length = ${nickNames.length}`);
        for (let i = 0; i < nickNames.length; i++) {
          this.nickname = nickNames[i];
          this.macAddr = macAddrs[i];
          this.myLogger(`in discoverDevices(), Device nickname = '${this.nickname}' MAC addr = '${this.macAddr}'`);
        }
        this.discoverDevicesFinished = true;
        return;
      },
    );
  }

  /***************** Find supported areas (Rooms) **********************/

  async getRoomList() {
    let cntr = 0;
    this.getRoomsFinished = false;
    await this.getRooms(this.nickname);
    this.myLogger('waiting for getRooms() to finish');
    while( ! this.getRoomsFinished ) {
      if( cntr++ > 45 ) {  // Wait up to 45 seconds (a first login with 2FA can take a while)
        break;
      }
      await setTimeout(1000);  // Delay 1 second
      this.myLogger(`GR cntr = '${cntr}'`);
    }
    this.myLogger(`at end of getRooms, this.Rooms.length() = '${this.rooms.length}'`);
  }

  async getRooms(nickname : string) {
    //
    // Get list of rooms from Wyze from the current map for this device
    //
    this.runPy('getVacuumFloors.py', [nickname],
      (error, stdout, stderr) => {
        if (error) {
          this.log.info(`error: ${error.message}`);
          this.getRoomsFinished = true;
          return;
        }
        if (stderr) {
          this.log.info(`stderr: ${stderr}`);
          this.getRoomsFinished = true;
          return;
        }
        let line = '';
        // Get individual lines of output from stdout
        for (let i = 0; i < stdout.length; i++) {
          const c = stdout.charAt(i);
          if (c === '\n') {
            this.rooms.push(line);
            this.myLogger(`room = '${line}'`);
            line = '';
            continue;
          }
          line = line.concat(stdout.charAt(i));
        }
        this.myLogger(`in discoverRooms(): this.rooms.length: ${this.rooms.length}`);
        this.getRoomsFinished = true;
        return;
      });
  }

  // =========================== Utilities ===================================

  /*
   * Run one of the Python helper scripts.
   *
   * The interpreter is started directly with an argument list (no shell), so
   * vacuum, floor and room names are passed as-is and cannot be misread as
   * shell syntax. Wyze credentials go only into the child's environment,
   * which, unlike the command line, other users on the machine cannot read.
   * Neither the arguments nor the environment are ever logged.
   */
  runPy(script : string, args : string[],
    callback : (error : ExecFileException | null, stdout : string, stderr : string) => void) {
    const env : NodeJS.ProcessEnv = {
      ...process.env,
      WYZE_EMAIL: String(this.config.username ?? ''),
      WYZE_PASSWORD: String(this.config.password ?? ''),
      WYZE_KEY_ID: String(this.config.key_id ?? ''),
      WYZE_API_KEY: String(this.config.api_key ?? ''),
      WYZE_TOTP_KEY: String(this.config.totpKey ?? ''),
      WYZE_TOKEN_FILE: this.tokenFile(),
      PYTHONWARNINGS: 'ignore',   // a library warning on stderr would otherwise be treated as a failure
      PYTHONDONTWRITEBYTECODE: '1',
    };
    const python = String(this.config.pythonPath || 'python3');
    const scriptPath = path.join(this.helperDir(), script);
    execFile(python, [scriptPath, ...args], { env, timeout: 90_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => callback(error, String(stdout), String(stderr)));
  }

  helperDir() : string {
    const configured = String(this.config.path2py_stubs ?? '').trim();
    if (configured) {
      return configured;
    }
    // Default: the py_helpers folder shipped with this plugin (dist/../py_helpers)
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
    : { runMode : number, opState : number, busy : boolean, label : string } | undefined {
    const S = RvcOperationalState.OperationalState;
    switch( status.replace(/^VacuumMode\./, '') ) {
      case 'CLEANING':
      case 'SWEEPING':
      case 'QUICK_MAPPING_MAPPING':
        return { runMode: 2, opState: S.Running, busy: true, label: 'cleaning' };
      case 'PAUSED':
      case 'PAUSE':
      case 'QUICK_MAPPING_PAUSED':
      case 'BREAK_POINT':
        return { runMode: 2, opState: S.Paused, busy: true, label: 'paused' };
      case 'RETURNING_TO_CHARGE':
      case 'FINISHED_RETURNING_TO_CHARGE':
      case 'FULL_FINISH_SWEEPING_ON_WAY_CHARGE':
      case 'QUICK_MAPPING_COMPLETED_RETURNING_TO_CHARGE':
        return { runMode: 1, opState: S.SeekingCharger, busy: true, label: 'returning to the dock' };
      case 'DOCKED_NOT_COMPLETE':
      case 'QUICK_MAPPING_DOCKED_NOT_COMPLETE':
        return { runMode: 2, opState: S.Charging, busy: false, label: 'charging, and will resume cleaning' };
      case 'IDLE':
        return onDock && battery < 100
          ? { runMode: 1, opState: S.Charging, busy: false, label: 'docked and charging' }
          : { runMode: 1, opState: S.Docked, busy: false, label: 'docked' };
      default:
        return undefined;
    }
  }

  stateKey(runMode : number, opState : number) : string {
    return `${runMode}:${opState}`;
  }

  // Statuses at which a run started from Home counts as over (cleaning finished,
  // paused, or docked to recharge mid-run).
  isSettled() : boolean {
    const mode = this.currentStatus.replace(/^VacuumMode\./, '');
    return ['IDLE', 'PAUSED', 'PAUSE', 'BREAK_POINT', 'QUICK_MAPPING_PAUSED',
      'DOCKED_NOT_COMPLETE', 'QUICK_MAPPING_DOCKED_NOT_COMPLETE'].includes(mode);
  }

  myLogger( line : string ) {
    switch( this.config.debugLevel ) {
      case 0:   // No logging
        return;
        break;
      case 1:   // Logging to homebridge.log
        this.log.info( line );
        break;
      case 2:   // Logging to system level logs.
        this.log.debug( line );
        break;
      default:
    }
  }

  setupSupportedAreas() {
    let floorCntr = 0;
    let roomCntr = 0;
    let saveFloorName = '';

    for (const room of this.rooms) {
      roomCntr++;
      const tmpList = room.split(':');
      const roomName = tmpList[0];;
      const floorName = tmpList[1];
      if( floorName !== saveFloorName ) {
        saveFloorName = floorName;
        floorCntr++;
        this.myLogger(`in setupSupportedAreas(); floorName[${floorCntr}] = '${floorName}'`);
        this.supportedMaps.push( this.floorMapEntry( floorCntr, floorName ));
      }
      this.myLogger(`in setupSupportedAreas(); roomName = '${roomName}'`);
      this.supportedAreas.push( this.supportedAreaEntry( roomCntr, floorCntr, roomName ));
    }
  }

  floorMapEntry( floorNum : number, floorName : string ) {
    return {
      mapId: floorNum,
      name: floorName,
    }
  }

  supportedAreaEntry( roomNum : number, floorNum: number, roomName : string ) {
    return {
      areaId: roomNum,
      mapId: floorNum,
      areaInfo: {
        locationInfo: {
          locationName: roomName,
          floorNumber: floorNum - 1,
          areaType: null,
        },
        landmarkInfo: null,
      },
    }
  }

  async doSweeping() {
    if( this.currentStatus === 'VacuumMode.IDLE' || this.newRoomsSelected ) {
      /*
       *   Check for special case of '*Entire Floor*' being checked In addition to other rooms.
       *   If true, remove the other rooms from the list
       */
      if( this.selectedAreas.length > 0 ) {
        for (let i = 0; i < this.selectedAreas.length; i++) {
          const areaId = this.selectedAreas[i];
          this.myLogger(`before StartSweep, selectedRoom[${i}] = '${areaId}'`);
          for (let j = 0; j < this.supportedAreas.length; j++) {
            const area = this.supportedAreas[j];
            if( area.areaId === areaId ) {
              this.myLogger(`selected room name = '${area.areaInfo.locationInfo.locationName}'`);
              if( area.areaInfo.locationInfo.locationName === '*Entire Floor*' ) {
                this.selectedAreas.length = 0;
                this.selectedAreas.push( area.areaId );
                this.log.info('Changing selected room(s) to be "*Entire Floor*"');
                break;
              }
            }
          }
        }
      } else { // No rooms are selected. Assume '*Entire Floor*' on 1st floor
        this.selectedAreas.push( 1 );
        this.log.info('Changing selected room to be "*Entire Floor*"');
      }
      /*
      * Start sweeping
      */
      this.newRoomsSelected = false;
      await this.setFloor();     // Set current floor based on what rooms were selected
      await this.startSweeping();   // Start sweeping when docked
    } else {
      await this.startCleaning();   // Resume cleaning after a pause
    }
    if( this.roboticVacuum ) {
      await this.roboticVacuum.setAttribute('RvcRunMode', 'currentMode', 2, this.log); // Cleaning
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalState',
        RvcOperationalState.OperationalState.Running, this.log);
      await this.roboticVacuum.setAttribute('RvcOperationalState', 'operationalError',
        { errorStateId: RvcOperationalState.ErrorState.NoError }, this.log);
      await this.roboticVacuum.updateAttribute(ServiceArea.Cluster.id, 'currentArea', this.selectedAreas[0], this.log);
      this.lastAppliedState = this.stateKey(2, RvcOperationalState.OperationalState.Running);
    }
    // Check the vacuum's status now and then on the fast interval. (The original
    // version waited here in a loop that could spin without pausing, freezing the
    // plugin, whenever another handler asked for an early status check.)
    this.commandGraceUntil = Date.now() + RoboVacMatterbridgeDynamicPlatform.COMMAND_GRACE_MS;
    this.pokeStatusLoop = true;
  }

  async startStatusLoop() {
    while( true ) {
      const refreshInterval = Number(await this.getStatus() );
      this.myLogger(`in startStatusLoop(): after getStatus(): refreshInterval = ${refreshInterval} seconds`);
      for( let i = 0; i < refreshInterval; i++ ) {
        if( this.pokeStatusLoop ) {
          break;   // Something external poked here. Re-evaluate for statusRefreshInterval
        }
        await setTimeout(1000);
      }
      this.pokeStatusLoop = false;
    }
  }
}
