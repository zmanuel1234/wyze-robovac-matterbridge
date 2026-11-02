# Starts sweeping the named rooms on the current map (an unknown name such as
# "*Entire Floor*" matches no room, which sweeps the whole floor).
from wyze_auth import run, fail, cli, find_vacuum_mac


def main(args):
    if len(args) < 2:
        fail("USAGE: vacuumStartSweep.py robovac_nickname roomname [roomname...]")
    nickname, rooms2clean = args[0], args[1:]

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


if __name__ == "__main__":
    cli(main)
