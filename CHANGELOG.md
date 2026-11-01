# <img src="matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;matterbridge-wyze-robovac
 
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
