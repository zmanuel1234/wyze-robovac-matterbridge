# Lists Wyze robot vacuums as "nickname:mac". Credentials come from the environment (see wyze_auth.py).
import sys
from wyze_auth import run, fail, VACUUM_MODEL

if len(sys.argv) != 1:
    fail(f"USAGE: {sys.argv[0]}  (credentials are read from WYZE_* environment variables)")


def body(client):
    for device in client.devices_list():
        if device.product.model == VACUUM_MODEL:
            print(f"{device.nickname}:{device.mac}")


run(body)
