# Pauses the current sweep.
from wyze_auth import run, fail, cli, find_vacuum_mac


def main(args):
    if len(args) != 1:
        fail("USAGE: vacuumPauseSweep.py robovac_nickname")
    nickname = args[0]

    def body(client):
        from wyze_sdk.models.devices import VacuumMode

        device_mac = find_vacuum_mac(client, nickname)
        vacuum = client.vacuums.info(device_mac=device_mac)
        if vacuum.mode == VacuumMode.IDLE:
            fail("RoboVac is docked (not sweeping)....")
        client.vacuums.pause(device_mac=device_mac, device_model=vacuum.product.model)
        print("Vacuum paused....")

    run(body)


if __name__ == "__main__":
    cli(main)
