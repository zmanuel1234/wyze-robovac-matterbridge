# Sends the vacuum back to its dock.
from wyze_auth import run, fail, cli, find_vacuum_mac


def main(args):
    if len(args) != 1:
        fail("USAGE: vacuumStopSweep.py robovac_nickname")
    nickname = args[0]

    def body(client):
        from wyze_sdk.models.devices import VacuumMode

        device_mac = find_vacuum_mac(client, nickname)
        vacuum = client.vacuums.info(device_mac=device_mac)
        if vacuum.mode == VacuumMode.IDLE:
            fail("RoboVac is already docked....")
        client.vacuums.dock(device_mac=device_mac, device_model=vacuum.product.model)
        print("Vacuum successfully sent back to charge....")

    run(body)


if __name__ == "__main__":
    cli(main)
