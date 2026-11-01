# Pauses the current sweep.
import sys
from wyze_auth import run, fail, find_vacuum_mac

if len(sys.argv) != 2:
    fail(f"USAGE: {sys.argv[0]} robovac_nickname")

nickname = sys.argv[1]


def body(client):
    from wyze_sdk.models.devices import VacuumMode

    device_mac = find_vacuum_mac(client, nickname)
    vacuum = client.vacuums.info(device_mac=device_mac)
    if vacuum.mode == VacuumMode.IDLE:
        fail("RoboVac is docked (not sweeping)....")
    client.vacuums.pause(device_mac=device_mac, device_model=vacuum.product.model)
    print("Vacuum paused....")


run(body)
