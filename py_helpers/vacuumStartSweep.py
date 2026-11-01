# Starts sweeping the named rooms on the current map (an unknown name such as
# "*Entire Floor*" matches no room, which sweeps the whole floor).
import sys
from wyze_auth import run, fail, find_vacuum_mac

if len(sys.argv) < 3:
    fail(f"USAGE: {sys.argv[0]} robovac_nickname roomname [roomname...]")

nickname = sys.argv[1]
rooms2clean = sys.argv[2:]


def body(client):
    from wyze_sdk.models.devices import VacuumMode

    device_mac = find_vacuum_mac(client, nickname)
    vacuum = client.vacuums.info(device_mac=device_mac)
    if vacuum.mode == VacuumMode.SWEEPING:
        fail("RoboVac is already sweeping. Stop the current sweep and try again...")

    room_ids = [room.id for room in vacuum.current_map.rooms if room.name in rooms2clean]
    client.vacuums.sweep_rooms(device_mac=device_mac, room_ids=room_ids)
    print("Sweeping started successfully...")


run(body)
