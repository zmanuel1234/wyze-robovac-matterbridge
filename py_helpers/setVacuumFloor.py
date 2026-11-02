# Makes the named floor the current map in the Wyze app.
from wyze_auth import run, fail, cli, find_vacuum_mac


def main(args):
    if len(args) != 2:
        fail("USAGE: setVacuumFloor.py robovac_nickname floor_name")
    nickname, new_floor_name = args

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
            valid = ", ".join(f"'{m.name.strip()}'" for m in maps)
            fail(f"'{new_floor_name}' is not a floor of this vacuum. Floors: {valid}")

        client.vacuums.set_current_map(device_mac=device_mac, map_id=new_floor_id)
        print(f"    current floor is now: {new_floor_name}")

    run(body)


if __name__ == "__main__":
    cli(main)
