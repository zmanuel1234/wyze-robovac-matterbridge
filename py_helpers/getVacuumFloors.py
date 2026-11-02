# Prints "room<TAB>floor" for every room on every map, plus "*Entire Floor*<TAB>floor" per floor.
# (Tab-separated, so room and floor names may contain ':'.)
import sys
from wyze_auth import run, fail, find_vacuum_mac

if len(sys.argv) != 2:
    fail(f"USAGE: {sys.argv[0]} robovac_nickname")

nickname = sys.argv[1]


def body(client):
    device_mac = find_vacuum_mac(client, nickname)
    for map_summary in client.vacuums.get_maps(device_mac=device_mac):
        print(f"*Entire Floor*\t{map_summary.name}")
        for room in map_summary.rooms:
            print(f"{room.name}\t{map_summary.name}")


run(body)
