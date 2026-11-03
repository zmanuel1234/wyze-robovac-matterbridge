# Prints "mode:battery_percent:is_charging:fault_name:suction:online:online_since" for the vacuum,
# e.g. "VacuumMode.IDLE:87:True:None:quiet:True:1762149273" (fault_name / suction are None when
# not reported; online is None and online_since empty when Wyze doesn't say). While the vacuum
# is offline, Wyze still reports its last known mode and battery.
from wyze_auth import run, fail, cli, find_vacuum_mac


def _suction(vacuum):
    """'quiet', 'standard' or 'strong'; None if Wyze didn't report it (or reported a code wyze-sdk can't read)."""
    try:
        level = vacuum.clean_level
    except (AttributeError, ValueError):
        return None
    return level.name.lower() if level is not None else None


def _online(vacuum):
    """('True' | 'False' | 'None', seconds since epoch of the last change or '')."""
    prop = getattr(vacuum, "_is_online", None)   # wyze-sdk keeps Wyze's connection state here
    value = getattr(prop, "value", None)
    if value is None:
        return "None", ""
    ts = getattr(prop, "ts", None)
    try:
        since = str(int(ts.timestamp())) if ts is not None else ""
    except (AttributeError, OverflowError, OSError, ValueError):
        since = ""
    return str(bool(value)), since


def main(args):
    if len(args) != 1:
        fail("USAGE: getVacuumStatus.py robovac_nickname")
    nickname = args[0]

    def body(client):
        device_mac = find_vacuum_mac(client, nickname)
        vacuum = client.vacuums.info(device_mac=device_mac)
        # fault_code is a VacuumFaultCode (or None); print just its name, e.g. COLLISION_EXCEPTION
        fault = getattr(vacuum.fault_code, "name", None) or "None"
        online, since = _online(vacuum)
        print(f"{vacuum.mode}:{vacuum.voltage}:{vacuum.is_charging}:{fault}:{_suction(vacuum)}:{online}:{since}")

    run(body)


if __name__ == "__main__":
    cli(main)
