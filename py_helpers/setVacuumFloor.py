# Makes the named floor the current map in the Wyze app.
import sys
from wyze_auth import run, fail, find_vacuum_mac

if len(sys.argv) != 3:
    fail(f"USAGE: {sys.argv[0]} robovac_nickname floor_name")

nickname = sys.argv[1]
new_floor_name = sys.argv[2]


def body(client):
    device_mac = find_vacuum_mac(client, nickname)
    maps = list(client.vacuums.get_maps(device_mac=device_mac))
    new_floor_id = 0
    for map_summary in maps:
        if map_summary.is_current:
            print(f"    current floor: {map_summary.name.strip()}")
        if map_summary.name.strip() == new_floor_name:
            new_floor_id = map_summary.id

    if new_floor_id == 0:
        print(f"     '{new_floor_name}' is not a valid floor name")
        print("     Valid names are:")
        for map_summary in maps:
            print(f"          {map_summary.name.strip()}")
        sys.exit(1)

    client.vacuums.set_current_map(device_mac=device_mac, map_id=new_floor_id)
    print(f"    current floor is now: {new_floor_name}")


run(body)
