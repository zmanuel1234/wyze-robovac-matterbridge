"""
Fake wyze-sdk for the tests: no network, no real account.

Everything the fake "Wyze cloud" knows lives in a JSON file named by the
MOCK_STATE environment variable, so a test can set the vacuum's state, expire
tokens, count logins and see which commands were sent ("events"). Keys:

  password            the account password a full login must match
  mode, battery,      what vacuums.info() reports (mode is a VacuumMode name)
  charging, fault,
  suction
  maps                optional [{"name": floor, "rooms": [...]}, ...]
  current_map         index of the current map (set_current_map changes it)
  map_lag             info() calls that still report the old map after set_current_map
  hold                seconds devices_list() sleeps (to test timeouts)
  mfa                 "totp" or "sms" to simulate two-factor prompts
  valid_access/_refresh, logins, refreshes, events   kept by the fake itself
"""
import datetime as _dt
import json
import logging
import os
import time
from types import SimpleNamespace as NS

from wyze_sdk.errors import WyzeApiError, WyzeClientConfigurationError
from wyze_sdk.models.devices import VacuumMode

VACUUM_MAC = "JA_RO2_TEST"
DEFAULT_MAPS = [
    {"name": "Main Floor", "rooms": ["Kitchen", "Living Room", "Den: East"]},
    {"name": "Up: stairs", "rooms": ["Bed"]},
]


def _st():
    with open(os.environ["MOCK_STATE"]) as f:
        return json.load(f)


def _save(d):
    with open(os.environ["MOCK_STATE"], "w") as f:
        json.dump(d, f)


def _log(event):
    d = _st()
    d.setdefault("events", []).append(event)
    _save(d)


def _maps(d):
    return d.get("maps") or DEFAULT_MAPS


def _room_id(map_index, room_index):
    return 11 + 10 * map_index + room_index


class _Vacuums:
    def __init__(self, client):
        self.c = client

    def info(self, device_mac):
        self.c._check()
        d = _st()
        if device_mac != VACUUM_MAC:
            raise WyzeApiError("The request to the Wyze API failed.", {"code": 1001, "msg": "bad device"})
        current = d.get("current_map", 0)
        if d.get("map_lag"):   # Wyze still reports the previous map for a moment
            current = d.get("previous_map", current)
            d["map_lag"] -= 1
            _save(d)
        rooms = [NS(id=_room_id(current, i), name=r) for i, r in enumerate(_maps(d)[current]["rooms"])]
        if d.get("sdk_warning"):   # like wyze-sdk's DeviceProp when Wyze sends a value it can't convert
            logging.getLogger("wyze_sdk.models.devices.base").warning("could not cast value `x` into expected type <class 'int'>")
        return NS(
            mode=VacuumMode[d.get("mode", "IDLE")],
            voltage=d.get("battery", 50),
            is_charging=d.get("charging", True),
            fault_code=NS(name=d["fault"]) if d.get("fault") else None,
            clean_level=NS(name=d["suction"].upper()) if d.get("suction") else None,
            product=NS(model="JA_RO2"),
            current_map=NS(rooms=rooms),
            # Like wyze-sdk's DeviceProp: absent when the test doesn't set "online"
            _is_online=None if "online" not in d else NS(
                value=d["online"], ts=_dt.datetime.fromtimestamp(d.get("online_since", 1700000000))),
        )

    def get_maps(self, device_mac):
        self.c._check()
        d = _st()
        return [NS(id=i + 1, name=m["name"], is_current=(i == d.get("current_map", 0)),
                   rooms=[NS(id=_room_id(i, j), name=r) for j, r in enumerate(m["rooms"])])
                for i, m in enumerate(_maps(d))]

    def set_current_map(self, device_mac, map_id):
        self.c._check()
        _log(f"set_map:{map_id}")
        d = _st()
        d["previous_map"], d["current_map"] = d.get("current_map", 0), map_id - 1
        _save(d)

    def sweep_rooms(self, device_mac, room_ids):
        self.c._check()
        _log(f"sweep:{room_ids}")

    def pause(self, device_mac, device_model):
        self.c._check()
        _log("pause")

    def clean(self, device_mac, device_model):
        self.c._check()
        _log("clean")

    def dock(self, device_mac, device_model):
        self.c._check()
        _log("dock")

    def set_suction_level(self, device_mac, device_model, suction_level):
        self.c._check()
        _log(f"suction:{suction_level.name}")
        d = _st()
        d["suction"] = suction_level.name.lower()
        _save(d)


class Client:
    def __init__(self, token=None, refresh_token=None, email=None, password=None,
                 key_id=None, api_key=None, totp_key=None, **_kw):
        self._token, self._refresh_token = token, refresh_token
        self._password, self._key_id, self._api_key, self._totp_key = password, key_id, api_key, totp_key
        if token is None and email is not None:
            self.login()

    def login(self):
        d = _st()
        if not self._key_id or not self._api_key:
            raise WyzeClientConfigurationError("Must provide a Wyze API key and id.")
        if self._password != d["password"]:
            raise WyzeApiError("The username or password is incorrect.", {"code": 1000, "msg": "UserNameOrPasswordError"})
        if d.get("mfa") == "totp":
            if not self._totp_key:
                input("Enter Wyze 2FA Verification Code: ")
            _log(f"totp_used:{self._totp_key}")
        elif d.get("mfa") == "sms":
            input("Enter Wyze SMS 2FA Verification Code: ")
        d = _st()
        d["logins"] = n = d.get("logins", 0) + 1
        d["valid_access"], d["valid_refresh"] = f"acc{n}", f"ref{n}"
        _save(d)
        self._token, self._refresh_token = f"acc{n}", f"ref{n}"

    def refresh_token(self):
        d = _st()
        if self._refresh_token != d.get("valid_refresh"):
            raise WyzeApiError("refresh failed", {"code": 2002, "msg": "RefreshTokenError"})
        d["refreshes"] = n = d.get("refreshes", 0) + 1
        d["valid_access"], d["valid_refresh"] = f"racc{n}", f"rref{n}"
        _save(d)
        self._token, self._refresh_token = f"racc{n}", f"rref{n}"

    def _check(self):
        if self._token != _st().get("valid_access"):
            raise WyzeApiError("The access token has expired. Please refresh the token and try again.",
                               {"code": 2001, "msg": "AccessTokenError"})

    def devices_list(self):
        self._check()
        _log("list")
        d = _st()
        if d.get("hold"):
            time.sleep(float(d["hold"]))
        return [NS(product=NS(model="JA_RO2"), nickname="Robby O'Vac", mac=VACUUM_MAC),
                NS(product=NS(model="HL_CAM3"), nickname="Cam", mac="CC")]

    @property
    def vacuums(self):
        return _Vacuums(self)
