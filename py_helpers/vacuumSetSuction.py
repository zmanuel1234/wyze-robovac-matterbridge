# Sets the vacuum's suction level: quiet, standard or strong.
from wyze_auth import run, fail, cli, find_vacuum_mac

LEVELS = ("quiet", "standard", "strong")


def main(args):
    if len(args) != 2 or args[1].lower() not in LEVELS:
        fail("USAGE: vacuumSetSuction.py robovac_nickname quiet|standard|strong")
    nickname, level_name = args[0], args[1].lower()

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


if __name__ == "__main__":
    cli(main)
