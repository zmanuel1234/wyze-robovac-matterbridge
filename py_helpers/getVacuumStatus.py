# Prints "mode:voltage:is_charging:fault_code" for the vacuum.
import sys
from wyze_auth import run, fail, find_vacuum_mac

if len(sys.argv) != 2:
    fail(f"USAGE: {sys.argv[0]} robovac_nickname")

nickname = sys.argv[1]


def body(client):
    device_mac = find_vacuum_mac(client, nickname)
    vacuum = client.vacuums.info(device_mac=device_mac)
    print(f"{vacuum.mode}:{vacuum.voltage}:{vacuum.is_charging}:{vacuum.fault_code}")


run(body)
