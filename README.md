# <img src="matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;matterbridge-wyze-robovac
  
[![npm](https://img.shields.io/npm/v/matterbridge-wyze-robovac)](https://www.npmjs.com/package/matterbridge-wyze-robovac/v/latest)
[![npm](https://img.shields.io/npm/dt/matterbridge-wyze-robovac)](https://www.npmjs.com/package/matterbridge-wyze-robovac)
[![GitHub last commit](https://img.shields.io/github/last-commit/RMCob/matterbridge-wyze-robovac)](https://github.com/RMCob/matterbridge-wyze-robovac)

---

Matterbridge plugin to control and report status of the Wyze S200 Robot Vacuum

> **1.0.8** is an unofficial, patched version of the original 1.0.1: secure credential handling, token caching, authenticator-app 2FA, Matterbridge 3.11 support, full vacuum state and fault reporting, and suction modes. See `CHANGELOG.md`. Don't install updates offered in the Matterbridge UI: they would replace it with the original plugin.

A Robot Vacuum Cleaner device (supported by SmartThings, Alexa, Home Assistant and partially by Apple Home). Read also https://github.com/Luligu/matterbridge/discussions/264. 

Based on the original plugin by Rob Coben: https://github.com/RMCob/matterbridge-wyze-robovac

## Requirements

- Python 3.9 or newer, with wyze-sdk ≥ 2.2.0 installed, ideally in its own virtual environment ([wyze-sdk](https://github.com/shauntarves/wyze-sdk)). Tested with wyze-sdk 2.2.0 on Python 3.9 (Raspberry Pi OS 11) and 3.11. Python 3.12+ installs a newer wyze-sdk with the same login and vacuum code.
- Matterbridge ≥ 3.11 ([installation](https://github.com/Luligu/matterbridge/blob/main/README.md)). Earlier releases of this plugin do not start on Matterbridge 3.11.
- A Wyze API key ID and API key from the [Wyze developer console](https://developer-api-console.wyze.com/#/apikey/view). Any characters are fine; they are never passed through a shell.
- If your Wyze account uses two-factor authentication, it must use an authenticator app (not SMS), and you need its setup key (see `totpKey` below).
- For Apple Home: iOS 18.4 or later and a home hub (Apple TV or HomePod).

## What it does

- Exposes the S200 as a Matter robot vacuum with the rooms and floors from the Wyze app, so Home can clean selected rooms, pause, resume and send it to the dock.
- Shows the vacuum's real state, including runs started from the Wyze app, a schedule or the button: cleaning, paused, returning to the dock, charging (also "charging, will resume") and docked.
- Shows Wyze faults as Matter errors while the vacuum is away from the dock: stuck, wheels jammed, lidar blocked, dust bin / water tank / mop missing, failed to find the dock, and so on.
- Offers three cleaning modes mapped to the suction levels: Standard, Quiet and Strong (set while the vacuum is docked).
- Reports the battery level and whether it is charging.

## Caveats

- Tested on a Raspberry Pi 4 (Raspberry Pi OS 11, 32-bit) with Matterbridge 3.11.1 running as a service under its own user, in bridge mode with the vacuum in server mode, and with Apple Home. Other setups (Docker, Home Assistant, other controllers) are untested.

- One vacuum per Matterbridge instance. With several vacuums, run one instance per vacuum and whitelist one in each (untested).

- The room list is read when the plugin starts. After re-mapping in the Wyze app, restart Matterbridge.

- All selected rooms should be on the same floor; the plugin switches the Wyze map to the floor of the first selected room. Selecting **\*Entire Floor\*** overrides any other room selection.

- The status is polled: every 45 s while cleaning, paused or returning, every 60 s while charging and every 5 min when fully charged (all configurable). Wyze may ignore requests if they come too often.

- Apple Home may keep showing an old battery percentage even though it receives updates; the Wyze app and the Matterbridge UI show the current value.

- After a command it takes 10–15 seconds for the vacuum to react.

## Configuration

Use the settings UI in Matterbridge browser interface to configure your Wyze account information, or manually add the following to the platforms section of your config file. See the **`Requirements`** section above for instructions on how to get your API_KEY and KEY_ID:

```
{
  "platforms": [
    {
      "platform": "WyzeRoboVac",
      "name": "WyzeRoboVac",
      "username": "YOUR_EMAIL",
      "password": "YOUR_PASSWORD",
      "key_id": "YOUR WYZE ACCOUNT KEY_ID",
      "api_key": "YOUR WYZE ACCOUNT API_KEY",
      "totpKey": "AUTHENTICATOR SETUP SEED (only if 2FA uses an authenticator app)",
      "busyStatusCheckRefreshInterval": 45,
      "idleStatusCheck1RefreshInterval": 300,
      "idleStatusCheck2RefreshInterval": 60,
      "path2py_stubs": "",
      "pythonPath": "/opt/wyze-venv/bin/python",
      "tokenFile": "",
      "debugLevel": 0
    }
  ]
}
```

### Optional fields

- **`totpKey`** – Only if your Wyze account uses an authenticator app for two-factor authentication. This is the secret key shown when you set up the app (the text behind the QR code), not a 6-digit code. It is used only when the plugin has to log in from scratch. SMS two-factor authentication cannot be used unattended.
- **`pythonPath`** – The Python interpreter that has `wyze-sdk` installed, e.g. the `python` inside a virtual environment. Defaults to `python3`.
- **`tokenFile`** – Where Wyze access/refresh tokens are cached (owner-only permissions). Defaults to `~/.matterbridge/wyze-robovac/tokens.json`.
- **`path2py_stubs`** – Folder with the Python helper scripts. Leave empty to use the ones bundled with the plugin.
- **`busyStatusCheckRefreshInterval`** – Seconds between status checks while the vacuum is cleaning, paused or returning to the dock. Defaults to 45 (minimum 25).
- **`idleStatusCheck1RefreshInterval`** – Seconds between status checks when docked with a full battery. Defaults to 300 (5 min, the minimum). This is also how quickly a run started outside Home shows up.
- **`idleStatusCheck2RefreshInterval`** – Seconds between status checks when docked and charging. Defaults to 60 (1 min, the minimum).

### How credentials are handled

The plugin never passes credentials on a command line and never logs them. Each helper receives them in its environment, logs in at most once, and then reuses a cached access token, refreshing it when it expires. If a login fails, it waits 15 minutes (or until the settings change) before trying again. See `CHANGELOG.md` for details.

## To Do

- Set the manufacturer name, model and firmware version shown on the device's **Info** page.

## Other Info

Special thanks to the following projects for reference and inspiration:

- [wyze-sdk](https://github.com/shauntarves/wyze-sdk), a Python library for controlling the Wyze Robot Vacuum and other Wyze products.
- [matterbridge-dynamic-plugin-example](https://github.com/Luligu/matterbridge-example-dynamic-platform).

Thanks again to [Shaun Tarves](https://github.com/shauntarves/wyze-sdk) for the Python libraries that this plugin utilizes, [Luligu](https://github.com/Luligu/matterbridge) for Matterbridge, and thanks to others for volunteering their time to help fix bugs and add support for other features.

## Building from source

```bash
npm install
npm run dev:matterbridge   # Matterbridge for type checking; not saved in package.json, because Matterbridge refuses plugins that list it
npm pack                   # checks dependencies, lints, builds and writes the .tgz
```
