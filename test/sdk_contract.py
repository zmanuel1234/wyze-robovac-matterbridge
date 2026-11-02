"""
Checks that the real wyze-sdk still has everything the helpers and the plugin use:
the client methods and arguments, the error classes, the vacuum modes and fault
names that src/platform.ts maps to Home states, and the suction levels.

Run with the real wyze-sdk installed (not test/mock):  python test/sdk_contract.py
Fails loudly if a wyze-sdk update renamed or removed something.
"""
import inspect
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "py_helpers"))

import wyze_sdk  # noqa: E402
from wyze_sdk import Client  # noqa: E402
from wyze_sdk.api.devices.vacuums import VacuumsClient  # noqa: E402
from wyze_sdk.errors import WyzeApiError, WyzeClientConfigurationError  # noqa: E402,F401
from wyze_sdk.models.devices import VacuumMode  # noqa: E402
from wyze_sdk.models.devices.vacuums import Vacuum, VacuumFaultCode, VacuumSuctionLevel  # noqa: E402

assert "mock" not in (wyze_sdk.__file__ or ""), "the fake wyze_sdk from test/mock is on the path"
problems = []


def need(cond, what):
    if not cond:
        problems.append(what)


params = inspect.signature(Client.__init__).parameters
for p in ("token", "refresh_token", "email", "password", "key_id", "api_key", "totp_key"):
    need(p in params, f"Client() has no '{p}' argument")
for m in ("devices_list", "refresh_token", "vacuums"):
    need(hasattr(Client, m), f"Client has no '{m}'")
for m in ("info", "get_maps", "set_current_map", "sweep_rooms", "pause", "clean", "dock", "set_suction_level"):
    need(hasattr(VacuumsClient, m), f"client.vacuums has no '{m}'")
need({"QUIET", "STANDARD", "STRONG"} <= {s.name for s in VacuumSuctionLevel}, "VacuumSuctionLevel lacks QUIET/STANDARD/STRONG")
for m in ("IDLE", "SWEEPING"):
    need(m in VacuumMode.__members__, f"VacuumMode has no {m} (used by the helper scripts)")

src = open(os.path.join(ROOT, "src", "platform.ts"), encoding="utf-8").read()
state_fn = src[src.index("matterStateFor(status"):src.index("matterErrorFor(fault")]
modes = set(re.findall(r"case '([A-Z_]+)':", state_fn))
need(modes, "could not find the mode list in src/platform.ts")
# Status lines print a mode's main name; aliases (e.g. ON_WAY_CHARGE = RETURNING_TO_CHARGE) never appear.
main_modes = {m.name for m in VacuumMode}
for m in sorted(modes - set(VacuumMode.__members__)):
    problems.append(f"platform.ts maps VacuumMode.{m}, which wyze-sdk doesn't have")
for m in sorted(main_modes - modes):
    problems.append(f"wyze-sdk has VacuumMode.{m}, which platform.ts doesn't map (Home state would not update)")
fault_table = src[src.index("const table : Record<string"):src.index("const hit = table[name]")]
faults = set(re.findall(r"^\s+([A-Z_]+): \[", fault_table, re.M))
for f in sorted(faults - set(VacuumFaultCode.__members__)):
    problems.append(f"platform.ts maps VacuumFaultCode.{f}, which wyze-sdk doesn't have")

import getVacuumStatus  # noqa: E402
for raw, expected in (({"cleanlevel": "1"}, "quiet"), ({"cleanlevel": "2"}, "standard"), ({"cleanlevel": "3"}, "strong"), ({}, None)):
    got = getVacuumStatus._suction(Vacuum(mac="m", product_model="JA_RO2", **raw))
    need(got == expected, f"suction level {raw} read as {got!r}, expected {expected!r}")

version = getattr(getattr(wyze_sdk, "version", None), "__version__", "?")
if problems:
    print(f"wyze-sdk {version} on Python {sys.version.split()[0]}: {len(problems)} problem(s)")
    for p in problems:
        print("  -", p)
    sys.exit(1)
print(f"wyze-sdk {version} on Python {sys.version.split()[0]}: everything the plugin uses is there "
      f"({len(modes)} modes, {len(faults)} faults)")
