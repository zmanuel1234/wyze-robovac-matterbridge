# Resumes cleaning after a pause.
from wyze_auth import run, fail, cli, find_vacuum_mac


def main(args):
    if len(args) != 1:
        fail("USAGE: vacuumStartClean.py robovac_nickname")
    nickname = args[0]

    def body(client):
        from wyze_sdk.models.devices import VacuumMode

        device_mac = find_vacuum_mac(client, nickname)
        vacuum = client.vacuums.info(device_mac=device_mac)
        if vacuum.mode == VacuumMode.IDLE:
            fail("RoboVac is docked (not sweeping)....")
        client.vacuums.clean(device_mac=device_mac, device_model=vacuum.product.model)
        print("Cleaning (Resume after 'Pause') started....")

    run(body)


if __name__ == "__main__":
    cli(main)
