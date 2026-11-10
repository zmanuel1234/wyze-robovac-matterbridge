# <img src="matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;matterbridge-wyze-robovac-plus
 
## [1.0.0] - 2025-11-22

- First full release. 

### ** Changed **

- Updated README to imphasize that this was not developed in a Docker environment.
- Updated dependancies and shortened Description string in package.json
- Reformatted platform.ts with **prettier**.

## [1.0.1] - 2025-11-28

### ** Changed **

- Updated Matterbridge dependency requirement in README.

## [1.0.1-secure.1] - 2026-11-01

Unofficial security and reliability patch on top of 1.0.1.

### ** Security **

- Python helpers are started with `execFile` and an argument list instead of a shell command. Vacuum, floor and room names (including ones with spaces or quotes) are passed as-is and can no longer be interpreted as shell syntax.
- Wyze credentials are passed to the helpers in environment variables, not on the command line, so they no longer show up in `ps`. The helpers remove them from their own environment as soon as they are read.
- Passwords and API keys are no longer written to the log at any debug level.
- Password and API key fields are masked in the settings UI.

### ** Changed **

- Login is shared by all helpers (`py_helpers/wyze_auth.py`): access and refresh tokens are cached in a file with owner-only permissions (default `~/.matterbridge/wyze-robovac/tokens.json`), refreshed when Wyze reports them expired, and a full email/password login only happens when no usable token exists. A lock prevents concurrent logins or refreshes.
- After a failed login the helpers wait 15 minutes (or until the settings change) before trying Wyze again, to avoid locking the account.
- Replaced the unused `mfaCode` setting with `totpKey`, the authenticator-app setup seed, so accounts with authenticator 2FA can log in unattended. SMS 2FA now fails with a clear message instead of hanging.
- New settings: `pythonPath` (e.g. a virtual environment's python) and `tokenFile`. `path2py_stubs` now defaults to the helpers bundled with the plugin.
- Helper scripts time out after 90 seconds instead of hanging indefinitely.

### ** Fixed **

- Startup crash on Matterbridge 3.11: the plugin imported `AreaNamespaceTag`, which current Matterbridge no longer exports.
- "Docked" messages from the helpers were never recognized (case mismatch), so the Home app state was not corrected after pause/resume/dock on a docked vacuum.
- Pause, resume and dock helpers crashed instead of reporting "Vacuum not found" when the nickname did not match.

## [1.0.1-secure.2] - 2026-11-01

### ** Fixed **

- The vacuum was rejected on Matterbridge 3.11 ("Behaviors have errors", rvcCleanMode.supportedModes "2 to 255"), so it never appeared under Devices and could not be paired. Matter requires at least two clean modes; the plugin declared one.

### ** Added **

- Moved `jest`, `rimraf` and the other build/test-only packages from runtime `dependencies` to `devDependencies`; the plugin has no runtime npm dependencies, so installs are much smaller.
- Three clean modes mapped to the S200's suction levels: Standard, Quiet and Strong. Choosing one in the Home app while the vacuum is idle sets the suction level through the new `py_helpers/vacuumSetSuction.py`. Mode number 2 is deliberately unused so older Matterbridge versions, which route clean-mode changes to the run-mode handler, can't mistake it for "start cleaning".

## [1.0.1-secure.3] - 2026-11-01

### ** Fixed **

- Every Wyze vacuum mode is now shown in the Home app: runs started outside Home (Wyze app, button, schedule) show as cleaning; all pause, return-to-dock, mapping and "resume after charging" variants are mapped; docked is shown as Charging until the battery is full.
- "Return to dock" from the Home app no longer holds the command until the vacuum has docked; the Home app shows it returning straight away.
- Pause and dock from the Home app are no longer rejected when the run was started outside Home (the plugin now knows the vacuum is cleaning).
- A poll made just after a Home command can no longer flip the tile back before the vacuum has reacted (40-second grace period).
- Removed a wait loop that could spin without pausing and freeze the plugin when an early status check was requested during a run.
- Startup waits up to 45 s (was 10 s) for the vacuum and room lookups, so a slow first login no longer leaves the vacuum missing.

### ** Changed **

- Default check intervals while docked: 60 s while charging (was 120 s) and 300 s when full (was 1800 s). Existing installs keep their saved values; change them in the plugin settings.
- The vacuum's ID is remembered between checks, saving one Wyze request per check; it is looked up again automatically if it stops working.

## [1.0.1-secure.4] - 2026-11-01

Housekeeping only; the plugin behaves exactly as 1.0.1-secure.3.

### ** Changed **

- Build tooling trimmed from 23 to 6 dev packages: removed jest and its lint plugin (no tests), the prettier/import/jsdoc/n/promise lint plugins, js-yaml, node-ansi-logger, node-persist-manager, npm-check-updates, shx, globals, @eslint/json, the FlatCompat helpers and rimraf.
- Moved to ESLint 10 with a native flat config (`eslint.config.mjs`); fixed three leftover no-op assignments it flagged.
- `matterbridge` (^3.11.1) is now a dev dependency, so builds are checked against a real Matterbridge version instead of a hand-made link.
- The package ships only what the plugin needs (`files` in package.json): compiled code, Python helpers, settings schema, sample config, README, CHANGELOG, LICENSE. No source maps, type declarations or author tooling.
- Removed the original author's publish script, CODEOWNERS, devcontainer, legacy .eslintrc, unused tsconfig.production.json and donation image.

## [1.2.0-dev-1] - 2026-11-10

Test version, published under npm's `dev` tag.

### ** Added **

- Run modes for controllers without a room list, such as Alexa, which offers them in routines: **Dock**, **Clean**, **Clean All** per floor and **Clean _room_** per room from the Wyze app ("Clean Kitchen"). A room name used on more than one floor, and "Clean All" with several floors, get the floor in brackets. Each floor and room keeps its number across restarts (`run-modes.json` next to the token cache), so a routine keeps pointing at the same room when rooms are added or reordered.
- While a run lasts, the vacuum shows the run mode that started it ("Clean Kitchen"); runs started in the Wyze app show as "Clean".

### ** Changed **

- The run modes formerly named "Idle" and "Cleaning" are named "Dock" and "Clean" (same numbers and meaning).
- The Wyze app's whole-floor entry no longer appears as a room named "\*Entire Floor\*" in Home. Selecting no rooms, or every room on a floor, cleans the whole floor.
- A different cleaning run mode chosen while the vacuum is busy is logged and not started (Matterbridge refuses that change too); previously only "Cleaning" existed.
- The run-mode handler is registered for run-mode changes only, so a suction change can never be taken for a run-mode change.

## [1.1.3] - 2026-11-03

### ** Fixed **

- A warning logged by wyze-sdk during a command (for example when Wyze sends a value it can't convert, which a firmware update can cause) made the command count as failed even though it had worked: a status check was skipped, or Home was told a start, pause or dock had been refused. Such warnings now go to the Matterbridge log as "Wyze helper: ..." lines and no longer affect the result.

## [1.1.2] - 2026-11-03

### ** Fixed **

- A vacuum that went offline (battery empty, switched off, out of Wi-Fi) kept showing in Home as whatever it was last doing, for example "paused, 12%" while the battery was long dead, because Wyze keeps reporting the last known state. The plugin now reads Wyze's online flag: while the vacuum is offline, Home shows an error ("Vacuum is offline") and the stale battery level isn't applied, the log says once that it went offline and since when, and status checks slow to the full-battery interval (5 min by default). The first check that finds it online again shows the real state and says so in the log.
- Commands from Home while the vacuum is offline (start, pause, dock, suction) are not sent to Wyze. The plugin checks once more first, in case it has just come back; if it is still offline the command is logged as not sent and Home shows the offline error again.

## [1.1.1] - 2026-11-03

### ** Fixed **

- Cleaning rooms on another floor: Wyze can keep reporting the previous floor for a few seconds after the plugin switches floors, so the requested rooms weren't found and the whole previous floor could be cleaned instead. The start command now waits up to 15 s for the new floor, and if the rooms still aren't there it starts nothing and Home shows the real state.
- Room and floor names with spaces at the start or end: they are now trimmed everywhere, so they match between the room list, the floor switch and the start command.
- An error while updating Home (for example a value Matterbridge refuses) ended the status checks for good; it is now logged and the next check runs as usual.
- Status-check intervals edited by hand in the config file below the documented minimums (25 s busy, 300 s full, 60 s charging) are raised to them, so Wyze isn't asked too often.

### ** Changed **

- Shorter package description, "Wyze RoboVac Plus", which Matterbridge also uses as the plugin's name in the log.
- Releases can publish to npm by themselves (npm trusted publishing), once enabled.

## [1.1.0] - 2026-11-03

First release on npm, under its own name.

### ** Changed **

- Renamed to `matterbridge-wyze-robovac-plus` and published on npm, so the Matterbridge UI installs and updates it like any plugin. The original `matterbridge-wyze-robovac` is unchanged on npm (1.0.0).
- No longer marked private. Settings files renamed to `matterbridge-wyze-robovac-plus.schema.json` / `.config.json`.
- Added `NOTICE` crediting the original plugin (Apache-2.0).
- README: installation and switching from the original plugin.
- `tools/migrate-to-plus.sh` moves an existing installation (settings, Matterbridge registration) to the new name, with a backup and `--rollback`.

No change to how the vacuum works.

## [1.0.14] - 2026-11-01

### Changed

- Marked the package `"private": true`. Matterbridge then no longer checks npm for updates to this plugin, so its page stops offering "Update the plugin to the latest version v.1.0.0", which would have replaced this version with the original 1.0.0 from npm (which does not start on Matterbridge 3.11). It also prevents publishing this package to npm by accident. Updates come from this repository's GitHub releases (`sudo wyze-plugin-update`).

## [1.0.13] - 2026-11-01

### Changed

- The plugin's author, shown in the Matterbridge plugin list, reads "RMCob, patched by zmanuel1234". The original author's copyright and licence notices are unchanged.
- The plugin's description in that list reads "Wyze S200 Robot Vacuum (patched)". The package name stays matterbridge-wyze-robovac, which Matterbridge uses for the settings and the Home pairing.

## [1.0.12] - 2026-11-01

### Added

- Releases are built and tested by GitHub: running the Release workflow on GitHub (or pushing a tag like `v1.0.12`) runs the tests, builds the package with a `build-info.json` recording the tag and commit, and publishes it with its SHA-256 checksum as a GitHub release.
- The plugin logs its version and, for GitHub-built packages, the release, commit and build date at startup, e.g. `Initializing platform: matterbridge-wyze-robovac 1.0.12 (GitHub release v1.0.12, commit 2f61f6e, built 2026-11-02)`.
- `tools/pi-update.sh` (installed on the Pi as `wyze-plugin-update`): shows what is installed against the newest release, installs a release after checking its checksum, backs up the previous version, restarts Matterbridge and confirms the plugin came up; `restore` puts a backed-up version back.

### Changed

- The package's homepage, repository and issue links point to this repository.

## [1.0.11] - 2026-11-01

### Added

- The room list is read again from Wyze every 6 hours while the vacuum is docked and idle, so rooms renamed or added in the Wyze app show up in Home without restarting the plugin. Rooms keep their IDs, so selections in Home stay valid; rooms that disappeared are dropped from the selection.
- Selecting rooms on more than one floor logs a clear warning naming the rooms that were skipped (the vacuum cleans one floor per run). Previously they were left out silently.

### Changed

- Removed the settings `path2py_stubs` (the bundled helpers are always used) and `debugLevel` (troubleshooting detail now follows Matterbridge's own log level). Both are ignored if still in a saved configuration.
- Clearer descriptions for the white list and black list settings.
- With no rooms selected, the first floor's "*Entire Floor*" area is looked up by name rather than assumed to be area 1.

## [1.0.10] - 2026-11-01

### Added

- Low-battery warnings in the Home app: the battery is reported as low at 20 % or less and critically low at 10 % or less, while the vacuum is off its dock. Charging on the dock always counts as OK.
- The suction level shown in Home (Standard, Quiet, Strong) now follows the vacuum, so a change made in the Wyze app shows up at the next status check. A level just chosen in Home is kept for 40 seconds while Wyze catches up; if Wyze refuses it, Home goes back to the real level straight away.
- getVacuumStatus.py prints the suction level as a fifth field (quiet, standard, strong or None).

## [1.0.9] - 2026-11-01

### Changed

- Faster: the plugin now starts one Python helper (`py_helpers/wyze_worker.py`) and keeps it running, instead of starting Python and loading wyze-sdk again for every status check and command. On a Raspberry Pi that start-up took seconds per command; starting from Home used three in a row.
- Credentials go to the helper over its input pipe, so they are no longer in any process's environment while it runs.
- The helper answers one request at a time. If it doesn't answer within 90 seconds it is restarted; if it exits, the next request starts a new one. It exits when Matterbridge stops the plugin.
- The individual helper scripts still work on their own, for testing by hand (same arguments and output as before).

## [1.0.8] - 2026-11-01

### Changed

- Removed the donation link from package.json (the heart icon in the Matterbridge plugin list and npm's "looking for funding" message) and the donation badge from the README. The README credits the original plugin instead.

## [1.0.7] - 2026-11-01

### Fixed

- Matterbridge refused to load 1.0.5 and 1.0.6 ("Found matterbridge package in the plugin devDependencies ... The plugin is disabled"): `matterbridge` was listed as a development dependency, which Matterbridge does not allow in any dependency list. It is now installed for development with `npm run dev:matterbridge` (not saved in package.json), and packing checks that no Matterbridge package is listed.

## [1.0.6] - 2026-11-01

Bug fixes and cleanup (unofficial patched version).

### Fixed

- A command Wyze refuses or fails (for example "pause" while docked) no longer leaves the Home app showing Paused, Cleaning or Returning: the real state is shown at the next check, a second or so later. Previously it was corrected inside the command, and Matterbridge then overwrote the correction.
- A failed start or resume no longer marks the vacuum as cleaning.
- Switching the run mode to Idle in the Home app now sends the vacuum to the dock. Before, Home showed "returning to dock" while it kept cleaning.
- Rooms and floors whose names contain ':' are read correctly (the helper now separates them with a tab).
- Starting works when the room list couldn't be read at startup (the whole current floor is cleaned).
- If Wyze is unreachable at startup, the vacuum lookup is retried twice, 30 s apart, with a clear error if it still fails.
- A missing battery reading no longer shows 0 %. "Fully charged" is only shown on the dock.
- Overlapping status checks (status loop, startup, commands) share one Wyze request instead of running side by side.
- The status loop stops when Matterbridge shuts the plugin down.
- A remembered vacuum ID is only discarded, and a command only retried, when the ID really is out of date, so a command that reached the vacuum is never sent twice.
- Network errors are logged as one line instead of a Python traceback; an unknown floor name gives a clear error.

### Changed

- Requires Matterbridge 3.11.0 or later (the version tested); the old check said 3.3.3.
- The placeholder area shown before the Wyze room list loads is named "Entire floor".
- Removed unused code and stale comments; token and status files share one private-file writer.

## [1.0.5] - 2026-11-01

From here on this patched line uses plain version numbers (1.0.5, 1.0.6, ...). The earlier builds were named 1.0.1-secure.1 to 1.0.1-secure.4; 1.0.5 is the same code as the build first named 1.0.1-secure.5.

### ** Added **

- Wyze faults are shown in the Home app as Matter errors while the vacuum is away from the dock: stuck, not on the ground, wheels jammed, lidar blocked, dust bin / water tank / mop missing, failed to find the dock, mapping or relocation failed, stuck in a no-go zone. Unknown faults show as a generic error with the Wyze fault name. A fault left over once the vacuum is back on the dock is ignored.

### ** Changed **

- Each Wyze call is now awaited directly instead of setting a "finished" flag and polling it once per second for up to 10 seconds (about 290 fewer lines). Commands reach the vacuum up to a second sooner.
- Resume decides between resuming the current run and starting a new one from a fresh status check, not from the last poll (which could predate a pause).
- When a command is refused because the vacuum is in another state (e.g. pause while docked), the Home app is refreshed with the real state straight away. Previously this check could never run: the helper's error exit was handled first.
- README: requirements, features and caveats describe this version; resolved To Do items removed.

### ** Fixed **

- No more "setAttribute vendorName error" at every start in server mode.
- Log typo "statusRefreshIinterval".
- Vacuum nicknames containing ':' are parsed correctly.
