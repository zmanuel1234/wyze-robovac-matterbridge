# Prints "mode:battery_percent:is_charging:fault_name" for the vacuum (fault_name is None when there is no fault).
import sys
from wyze_auth import run, fail, find_vacuum_mac

if len(sys.argv) != 2:
    fail(f"USAGE: {sys.argv[0]} robovac_nickname")

nickname = sys.argv[1]


def body(client):
    device_mac = find_vacuum_mac(client, nickname)
    vacuum = client.vacuums.info(device_mac=device_mac)
    # fault_code is a VacuumFaultCode (or None); print just its name, e.g. COLLISION_EXCEPTION
    fault = getattr(vacuum.fault_code, "name", None) or "None"
    print(f"{vacuum.mode}:{vacuum.voltage}:{vacuum.is_charging}:{fault}")


run(body)
