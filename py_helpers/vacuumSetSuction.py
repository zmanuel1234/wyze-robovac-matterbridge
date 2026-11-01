# Sets the vacuum's suction level: quiet, standard or strong.
import sys
from wyze_auth import run, fail, find_vacuum_mac

LEVELS = ("quiet", "standard", "strong")

if len(sys.argv) != 3 or sys.argv[2].lower() not in LEVELS:
    fail(f"USAGE: {sys.argv[0]} robovac_nickname quiet|standard|strong")

nickname = sys.argv[1]
level_name = sys.argv[2].lower()


def body(client):
    from wyze_sdk.models.devices.vacuums import VacuumSuctionLevel

    device_mac = find_vacuum_mac(client, nickname)
    vacuum = client.vacuums.info(device_mac=device_mac)
    level = {"quiet": VacuumSuctionLevel.QUIET,
             "standard": VacuumSuctionLevel.STANDARD,
             "strong": VacuumSuctionLevel.STRONG}[level_name]
    client.vacuums.set_suction_level(device_mac=device_mac, device_model=vacuum.product.model, suction_level=level)
    print(f"Suction level set to {level_name}")


run(body)
