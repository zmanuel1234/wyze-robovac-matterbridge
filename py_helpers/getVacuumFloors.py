# Prints "room<TAB>floor" for every room on every map, plus "*Entire Floor*<TAB>floor" per floor.
# (Tab-separated, so room and floor names may contain ':'.) Names are trimmed, the same way
# setVacuumFloor.py and vacuumStartSweep.py compare them.
from wyze_auth import run, fail, cli, find_vacuum_mac, clean_name, rooms_of


def main(args):
    if len(args) != 1:
        fail("USAGE: getVacuumFloors.py robovac_nickname")
    nickname = args[0]

    def body(client):
        device_mac = find_vacuum_mac(client, nickname)
        for map_summary in client.vacuums.get_maps(device_mac=device_mac) or []:
            floor = clean_name(map_summary.name)
            print(f"*Entire Floor*\t{floor}")
            for room in rooms_of(map_summary):
                name = clean_name(room.name)
                if name:   # an unnamed room can't be picked by name
                    print(f"{name}\t{floor}")

    run(body)


if __name__ == "__main__":
    cli(main)
