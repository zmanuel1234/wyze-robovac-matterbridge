# Prints "room<TAB>floor" for every room on every map, plus "*Entire Floor*<TAB>floor" per floor.
# (Tab-separated, so room and floor names may contain ':'.) Names are trimmed, the same way
# setVacuumFloor.py and vacuumStartSweep.py compare them.
from wyze_auth import run, fail, cli, find_vacuum_mac


def main(args):
    if len(args) != 1:
        fail("USAGE: getVacuumFloors.py robovac_nickname")
    nickname = args[0]

    def body(client):
        device_mac = find_vacuum_mac(client, nickname)
        for map_summary in client.vacuums.get_maps(device_mac=device_mac):
            floor = map_summary.name.strip()
            print(f"*Entire Floor*\t{floor}")
            for room in map_summary.rooms:
                print(f"{room.name.strip()}\t{floor}")

    run(body)


if __name__ == "__main__":
    cli(main)
