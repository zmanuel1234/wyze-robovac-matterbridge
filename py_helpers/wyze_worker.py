"""
Long-running helper for matterbridge-wyze-robovac.

Starting Python and loading wyze-sdk takes several seconds on a Raspberry Pi, so
the plugin starts this script once and sends it one request per line instead of
running a new helper for every command.

Protocol (one JSON object per line):

  first line, plugin -> worker:  {"env": {"WYZE_EMAIL": ..., "WYZE_TOKEN_FILE": ..., ...}}
  then, plugin -> worker:        {"id": 7, "cmd": "getVacuumStatus", "args": ["Home Vacuum"]}
  worker -> plugin:              {"id": 7, "ok": true, "out": "VacuumMode.IDLE:100:True:None\n", "err": ""}

The credentials come in the first line rather than in this process's environment,
so they are never visible in /proc/<pid>/environ while the worker runs. Requests
are handled one at a time, in order. "cmd" is the name of one of the helper
scripts next to this file; its main(args) runs with output captured.
"""

import contextlib
import importlib
import io
import json
import os
import sys

COMMANDS = {
    "getVacuumDeviceList", "getVacuumFloors", "getVacuumStatus", "setVacuumFloor",
    "vacuumPauseSweep", "vacuumSetSuction", "vacuumStartClean", "vacuumStartSweep", "vacuumStopSweep",
}

_protocol = sys.stdout   # only answers are written here
sys.stdout = sys.stderr  # anything else printed by accident goes to the log, not into the protocol


def _first_line(text):
    return (str(text).strip().split("\n")[0]) or "no details"


def _handle(request, wyze_auth):
    name = request.get("cmd")
    args = [str(a) for a in (request.get("args") or [])]
    if name not in COMMANDS:
        return {"ok": False, "out": "", "err": f"Unknown helper command {name!r}"}
    out, err = io.StringIO(), io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            importlib.import_module(name).main(args)
    except wyze_auth.HelperError as e:
        err.write(str(e))
    except SystemExit as e:
        if not err.getvalue().strip():
            err.write(f"{name} stopped (exit code {e.code})")
    except Exception as e:  # never let one bad request end the worker
        err.write(f"{name} failed: {type(e).__name__}: {_first_line(e)}")
    message = err.getvalue().strip()
    return {"ok": not message, "out": out.getvalue(), "err": message}


def main():
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

    first = sys.stdin.readline()
    try:
        env = json.loads(first).get("env") or {}
    except (ValueError, AttributeError):
        env = {}
    for key, value in env.items():
        if key.startswith("WYZE_"):
            os.environ[key] = str(value)

    import wyze_auth  # reads the WYZE_* values and removes them from the environment again
    wyze_auth.worker_mode()

    while True:
        line = sys.stdin.readline()
        if not line:
            return  # plugin closed the pipe: shut down
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        answer = _handle(request, wyze_auth)
        answer["id"] = request.get("id")
        _protocol.write(json.dumps(answer) + "\n")
        _protocol.flush()


if __name__ == "__main__":
    main()
