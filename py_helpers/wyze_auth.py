"""
Shared Wyze login for the matterbridge-wyze-robovac helper scripts.

Used two ways: by wyze_worker.py, the long-running helper the plugin talks to,
and by the individual helper scripts when they are run by hand for testing.

Credentials arrive in environment variables (never on the command line, so they
are not visible in `ps`). The worker sets them from the plugin's first message,
so they never appear in any process environment:

  WYZE_EMAIL, WYZE_PASSWORD, WYZE_KEY_ID, WYZE_API_KEY   required for a full login
  WYZE_TOTP_KEY                                           optional authenticator-app seed (2FA)
  WYZE_TOKEN_FILE                                         where access/refresh tokens are cached

A full email/password login only happens when there is no usable cached token.
Otherwise the cached access token is used, and refreshed when Wyze reports it
expired. The token file is created with mode 0600 inside a 0700 directory, and a
lock file stops concurrent helpers from logging in or refreshing at the same time.
"""

import builtins
import fcntl
import hashlib
import json
import os
import sys
import time

from wyze_sdk import Client
from wyze_sdk.errors import WyzeApiError, WyzeClientConfigurationError

VACUUM_MODEL = "JA_RO2"

_ENV_KEYS = ("WYZE_EMAIL", "WYZE_PASSWORD", "WYZE_KEY_ID", "WYZE_API_KEY", "WYZE_TOTP_KEY")


class AuthError(Exception):
    """Login failed in a way the user has to fix (bad credentials, SMS 2FA, ...)."""


class HelperError(Exception):
    """A command failed; raised instead of exiting when running inside wyze_worker.py."""


_in_worker = False


def worker_mode():
    """Report failures as HelperError instead of exiting (see fail)."""
    global _in_worker
    _in_worker = True


def _no_prompt(*_args, **_kwargs):
    # wyze-sdk falls back to input() for SMS 2FA, or for authenticator 2FA without
    # a seed. A background plugin can never answer, so fail fast with a clear message.
    raise AuthError(
        "Wyze asked for a 2FA code. Set 'totpKey' (the authenticator-app setup seed) in the "
        "plugin settings; SMS 2FA cannot be used unattended."
    )


builtins.input = _no_prompt

# Read the secrets once, then drop them from the environment so nothing this
# process might start later inherits them.
_creds = {k: (os.environ.pop(k, "") or "").strip() for k in _ENV_KEYS}
_token_file = os.path.expanduser(
    os.environ.get("WYZE_TOKEN_FILE", "~/.matterbridge/wyze-robovac/tokens.json")
)
_fail_file = _token_file + ".loginfail"
_devices_file = _token_file + ".devices.json"   # nickname -> MAC, saves a device-list request per call
_used_cached_mac = False


def fail(message, code=1):
    """Report a failure: inside the worker raise HelperError, otherwise print to stderr and exit."""
    if _in_worker:
        raise HelperError(message)
    print(message, file=sys.stderr)
    sys.exit(code)


def cli(main):
    """Entry point for running a helper script by hand: main(command-line arguments)."""
    main(sys.argv[1:])


# ----------------------------------------------------------------- token file

def _ensure_dir():
    d = os.path.dirname(_token_file)
    os.makedirs(d, mode=0o700, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass


def _load_tokens():
    try:
        with open(_token_file, "r", encoding="utf-8") as f:
            data = json.load(f)
        if data.get("access_token") and data.get("refresh_token"):
            return data
    except (OSError, ValueError):
        pass
    return None


def _write_private_json(path, data):
    _ensure_dir()
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def _save_tokens(client):
    _write_private_json(_token_file, {
        "access_token": client._token,
        "refresh_token": client._refresh_token,
        "saved_at": int(time.time()),
    })


class _Lock:
    def __enter__(self):
        _ensure_dir()
        self._fd = os.open(_token_file + ".lock", os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(self._fd, fcntl.LOCK_EX)
        return self

    def __exit__(self, *exc):
        fcntl.flock(self._fd, fcntl.LOCK_UN)
        os.close(self._fd)


# ---------------------------------------------------------------------- login

LOGIN_RETRY_SECONDS = 15 * 60


def _creds_fingerprint():
    h = hashlib.sha256()
    for k in _ENV_KEYS:
        h.update(_creds[k].encode() + b"\0")
    return h.hexdigest()


def _login_blocked():
    """
    After a failed full login, don't hammer Wyze on every status poll (repeated
    bad logins can lock the account). Retry only after LOGIN_RETRY_SECONDS, or
    straight away if the settings have changed since the failure.
    """
    try:
        with open(_fail_file, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if data.get("creds") != _creds_fingerprint():
        return None
    wait = int(data.get("at", 0) + LOGIN_RETRY_SECONDS - time.time())
    if wait <= 0:
        return None
    return (data.get("reason", "Wyze login failed") +
            f" (not retrying for {wait // 60 + 1} min, or until the plugin settings change)")


def _record_login_failure(reason):
    _write_private_json(_fail_file, {"at": int(time.time()), "creds": _creds_fingerprint(), "reason": reason})


def _full_login():
    blocked = _login_blocked()
    if blocked:
        raise AuthError(blocked)
    missing = [k for k in ("WYZE_EMAIL", "WYZE_PASSWORD", "WYZE_KEY_ID", "WYZE_API_KEY") if not _creds[k]]
    if missing:
        raise AuthError("Missing Wyze settings: " + ", ".join(m.replace("WYZE_", "").lower() for m in missing))
    totp = _creds["WYZE_TOTP_KEY"].replace(" ", "").upper() or None
    try:
        client = Client(
            email=_creds["WYZE_EMAIL"],
            password=_creds["WYZE_PASSWORD"],
            key_id=_creds["WYZE_KEY_ID"],
            api_key=_creds["WYZE_API_KEY"],
            totp_key=totp,
        )
    except (WyzeApiError, WyzeClientConfigurationError) as e:
        # Only the SDK's own one-line message, not the raw server response.
        reason = "Wyze login failed: " + str(e).split("\n")[0]
        _record_login_failure(reason)
        raise AuthError(reason) from None
    except AuthError as e:
        _record_login_failure(str(e))
        raise
    try:
        os.remove(_fail_file)
    except OSError:
        pass
    _save_tokens(client)
    return client


def _is_token_error(err):
    resp = getattr(err, "response", None)
    code = None
    msg = ""
    try:
        code = resp.get("code")
        msg = str(resp.get("msg", ""))
    except Exception:
        pass
    return str(code) == "2001" or msg == "AccessTokenError" or "access token has expired" in str(err)


def _reauth(stale_token):
    """Refresh (or, failing that, fully log in) under the lock. Returns a new Client."""
    with _Lock():
        cached = _load_tokens()
        # Another helper already refreshed while we waited for the lock.
        if cached and cached["access_token"] != stale_token:
            return Client(token=cached["access_token"], refresh_token=cached["refresh_token"])
        if cached:
            client = Client(token=cached["access_token"], refresh_token=cached["refresh_token"])
            try:
                client.refresh_token()
                _save_tokens(client)
                return client
            except Exception:
                pass  # refresh token also expired or revoked; fall through to a full login
        return _full_login()


def get_client():
    cached = _load_tokens()
    if cached:
        return Client(token=cached["access_token"], refresh_token=cached["refresh_token"])
    return _reauth(stale_token=None)


def run(body):
    """
    Call body(client). If Wyze rejects the access token, re-authenticate once
    and call body again. Expiry surfaces on the first API call, before any
    command has been sent, so re-running the body is safe.
    """
    global _used_cached_mac
    _used_cached_mac = False
    try:
        client = get_client()
        try:
            return body(client)
        except WyzeApiError as e:
            if _is_token_error(e):
                client = _reauth(stale_token=client._token)
                return body(client)
            if _used_cached_mac and _cached_mac_is_stale(client):
                # The remembered vacuum ID was out of date (vacuum replaced or re-added):
                # it is forgotten now, so the second run looks the vacuum up again.
                # Only retried when the ID was wrong, so a command that reached the
                # vacuum is never sent twice.
                _used_cached_mac = False
                return body(client)
            raise
    except HelperError:
        raise  # the command's own failure message, already worded for the log
    except AuthError as e:
        fail(str(e))
    except WyzeApiError as e:
        fail("Got an error: " + str(e).split("\n")[0])
    except Exception as e:  # network trouble etc.: one line instead of a traceback
        fail(f"Wyze request failed: {type(e).__name__}: " + (str(e).split("\n")[0] or "no details"))


def _forget_macs():
    try:
        os.remove(_devices_file)
    except OSError:
        pass


def _cached_mac_is_stale(client):
    """True (and the cache dropped) if the remembered vacuum ID is no longer on the account."""
    try:
        with open(_devices_file, "r", encoding="utf-8") as f:
            cached = set(json.load(f).values())
        current = {d.mac for d in client.devices_list() if d.product.model == VACUUM_MODEL}
    except (OSError, ValueError, WyzeApiError):
        return False
    if cached & current:
        return False
    _forget_macs()
    return True


def find_vacuum_mac(client, nickname):
    """
    The vacuum's ID (MAC) for its nickname. Remembered after the first lookup, so
    regular status checks don't fetch the whole Wyze device list every time.
    """
    global _used_cached_mac
    try:
        with open(_devices_file, "r", encoding="utf-8") as f:
            mac = json.load(f).get(nickname)
        if mac:
            _used_cached_mac = True
            return mac
    except (OSError, ValueError):
        pass
    for device in client.devices_list():
        if device.product.model == VACUUM_MODEL and device.nickname == nickname:
            try:
                _write_private_json(_devices_file, {nickname: device.mac})
            except OSError:
                pass
            return device.mac
    fail("Vacuum not found in list of Wyze devices...")
