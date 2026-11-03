# Starts sweeping the named rooms on the current map. "*Entire Floor*" (alone) sweeps the
# whole floor.
#
# The plugin switches the floor (setVacuumFloor.py) just before this runs, and Wyze can take
# a few seconds to report the new floor as the current map. So when a requested room isn't
# on the current map yet, this asks again for up to MAP_SWITCH_WAIT seconds, and fails
# rather than quietly sweeping the whole floor if the rooms still aren't there.
import os
import time

from wyze_auth import run, fail, cli, find_vacuum_mac

ENTIRE_FLOOR = "*Entire Floor*"
MAP_SWITCH_WAIT = float(os.environ.get("WYZE_MAP_SWITCH_WAIT", "15"))
MAP_SWITCH_POLL = float(os.environ.get("WYZE_MAP_SWITCH_POLL", "3"))


def main(args):
    if len(args) < 2:
        fail("USAGE: vacuumStartSweep.py robovac_nickname roomname [roomname...]")
    nickname = args[0]
    wanted = [name.strip() for name in args[1:] if name.strip() and name.strip() != ENTIRE_FLOOR]

    def body(client):
        from wyze_sdk.models.devices import VacuumMode

        device_mac = find_vacuum_mac(client, nickname)
        deadline = time.monotonic() + MAP_SWITCH_WAIT
        while True:
            vacuum = client.vacuums.info(device_mac=device_mac)
            if vacuum.mode == VacuumMode.SWEEPING:
                fail("RoboVac is already sweeping. Stop the current sweep and try again...")
            rooms = {room.name.strip(): room.id for room in vacuum.current_map.rooms}
            missing = [name for name in wanted if name not in rooms]
            if not missing or time.monotonic() >= deadline:
                break
            time.sleep(MAP_SWITCH_POLL)

        if wanted and len(missing) == len(wanted):
            fail(f"Room(s) {', '.join(wanted)} not on the vacuum's current map; nothing started. "
                 f"Rooms on it: {', '.join(sorted(rooms)) or 'none'}")
        room_ids = [rooms[name] for name in wanted if name in rooms]
        client.vacuums.sweep_rooms(device_mac=device_mac, room_ids=room_ids)
        if missing:
            print(f"Sweeping started; not on the current map, skipped: {', '.join(missing)}")
        else:
            print("Sweeping started successfully...")

    run(body)


if __name__ == "__main__":
    cli(main)
