# Prints "mode:battery_percent:is_charging:fault_name" for the vacuum (fault_name is None when there is no fault).
from wyze_auth import run, fail, cli, find_vacuum_mac


def main(args):
    if len(args) != 1:
        fail("USAGE: getVacuumStatus.py robovac_nickname")
    nickname = args[0]

    def body(client):
        device_mac = find_vacuum_mac(client, nickname)
        vacuum = client.vacuums.info(device_mac=device_mac)
        # fault_code is a VacuumFaultCode (or None); print just its name, e.g. COLLISION_EXCEPTION
        fault = getattr(vacuum.fault_code, "name", None) or "None"
        print(f"{vacuum.mode}:{vacuum.voltage}:{vacuum.is_charging}:{fault}")

    run(body)


if __name__ == "__main__":
    cli(main)
