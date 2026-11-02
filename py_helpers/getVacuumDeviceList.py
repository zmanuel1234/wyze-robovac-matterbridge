# Lists Wyze robot vacuums as "nickname:mac". Credentials come from the environment (see wyze_auth.py).
from wyze_auth import run, fail, cli, VACUUM_MODEL


def main(args):
    if args:
        fail("USAGE: getVacuumDeviceList.py  (credentials are read from WYZE_* environment variables)")

    def body(client):
        for device in client.devices_list():
            if device.product.model == VACUUM_MODEL:
                print(f"{device.nickname}:{device.mac}")

    run(body)


if __name__ == "__main__":
    cli(main)
