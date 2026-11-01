# <img src="matterbridge.svg" alt="Matterbridge Logo" width="64px" height="64px">&nbsp;&nbsp;&nbsp;matterbridge-wyze-robovac
  
[![npm](https://img.shields.io/npm/v/matterbridge-wyze-robovac)](https://www.npmjs.com/package/matterbridge-wyze-robovac/v/latest)
[![npm](https://img.shields.io/npm/dt/matterbridge-wyze-robovac)](https://www.npmjs.com/package/matterbridge-wyze-robovac)
[![GitHub last commit](https://img.shields.io/github/last-commit/RMCob/matterbridge-wyze-robovac)](https://github.com/RMCob/matterbridge-wyze-robovac)
[![Donate](https://img.shields.io/badge/Donate-PayPal-blue)](https://www.paypal.com/donate/?business=G63Z63BWAJWZN&no_recurring=0&currency_code=USD)

---

Matterbridge plugin to control and report status of the Wyze S200 Robot Vacuum

> **1.0.1-secure.1** is an unofficial patch of 1.0.1 that changes how Wyze credentials are handled and adds token caching and authenticator-app 2FA support. See `CHANGELOG.md`.

A Robot Vacuum Cleaner device (supported by SmartThings, Alexa, Home Assistant and partially by Apple Home). Read also https://github.com/Luligu/matterbridge/discussions/264. 

If you like this project and find it useful, please consider giving it a star on GitHub at https://github.com/rmcob/matterbridge-wyze-robovac and sponsoring it.

## Requirements

Python version must be >= 3.11.2.

wyze-sdk version must be >= 2.2.0.  Installation instructions are [here](https://github.com/shauntarves/wyze-sdk).

matterbridge version must be >= 3.4.0. Installation instructions are [here](https://github.com/Luligu/matterbridge/blob/main/README.md).

Visit the Wyze developer API portal to generate an API ID/KEY: **https://developer-api-console.wyze.com/#/apikey/view**.
This info is used in the Matterbridge Config settings for this plugin. See the **`Configuration`** section below. Be careful to check that the generated keys do **NOT** contain any 'shell' special characters like '*' or '|' (vertical bar). If they do, delete the keys (via the web browser interface) and regenerate them.

## Caveats

- This plugin was developed and proved-in on a RPi 5 running the latest versions of Raspbian Linux (6.12.47+rpt-rpi-2712), and Matterbridge (3.4.0) running in 'bridge' mode and **NOT in a Docker container**. If you are running in ANY other environment (Windows, Mac OS, Docker, Home Assistant, Synergy NAS, etc.) and have any issues with installation and or running, you are on your own. If you are successful in alternate environments I welcome your feedback so I can document it here.

- If you have multiple vacuums you will need to run multiple instances of Matterbridge, one per vacuums, whitelisting each vacuum to a particular instance. Since I only have one vacuum this situation has never been tested.

- The plugin only reads the room list once when it starts. If you re-map your floorplan with the Wyze app, the plugin must be restarted.

- If you start sweeping a room that is on a different floor than the 'current' floor shown in the Wyze app, the plugin will cause the map shown in the app to change to the floor the room being swept is on.

- The statusCheckRefreshInterval indicates how often to check that the vacuum is still sweeping after being started. Wyze servers start ignoring requests if you poll them too often. This will cause the **`py_helpers`** scripts to fail and the plugin will get out of sync with the vacuum. If that happens, use the Wyze app to send the vacuum back to the dock and they should re-sync after it docks.

- If **\*Entire Floor\*** is selected in the list of rooms to be cleaned it will override any other room selection. In this context, selecting "Entire Floor" in the plugin UI is the same as using the Wyze app and not selecting any specific rooms, which indicates that the entire floor should be swept.
- From the time a room cleaning is requested, it takes 10-15 seconds for the vacuum to activate.

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
      "idleStatusCheck1RefreshInterval": 1800,
      "idleStatusCheck2RefreshInterval": 120,
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
- **`busyStatusCheckRefreshInterval`** – Seconds between status checks while the vacuum is sweeping. Defaults to 45.
- **`idleStatusCheck1RefreshInterval`** – Seconds between status checks when docked with a full battery. Defaults to 1800 (30 min).
- **`idleStatusCheck2RefreshInterval`** – Seconds between status checks when docked and charging. Defaults to 120 (2 min).

### How credentials are handled (1.0.1-secure.1)

The plugin never passes credentials on a command line and never logs them. Each helper receives them in its environment, logs in at most once, and then reuses a cached access token, refreshing it when it expires. If a login fails, it waits 15 minutes (or until the settings change) before trying again. See `CHANGELOG.md` for details.

## To Do

- The Manufacturer name, model number, and firnware version need to be set on the **`Info`** page of the UI.

- There is no error reporting if the vacuum gets stuck or lost, dust bin removed, etc.

## Other Info

Special thanks to the following projects for reference and inspiration:

- [wyze-sdk](https://github.com/shauntarves/wyze-sdk), a Python library for controlling the Wyze Robot Vacuum and other Wyze products.
- [matterbridge-dynamic-plugin-example](https://github.com/Luligu/matterbridge-example-dynamic-platform).

Thanks again to [Shaun Tarves](https://github.com/shauntarves/wyze-sdk) for the Python libraries that this plugin utilizes, [Luligu](https://github.com/Luligu/matterbridge) for Matterbridge, and thanks to others for volunteering their time to help fix bugs and add support for other features.

