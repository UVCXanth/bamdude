"""Windows psutil interface-enumeration path for network_utils.

The Linux path uses fcntl ioctls (unavailable on Windows), so
``get_network_interfaces`` routes to ``_get_network_interfaces_psutil`` on
win32. These tests exercise that helper directly (mocking psutil) so the
filtering logic is covered on any platform.
"""

import socket
from types import SimpleNamespace
from unittest.mock import patch

from backend.app.services import network_utils


def _addr(ip, netmask, family=socket.AF_INET):
    return SimpleNamespace(family=family, address=ip, netmask=netmask, broadcast=None, ptp=None)


def _stats(isup=True):
    return SimpleNamespace(isup=isup, duplex=0, speed=0, mtu=1500)


def test_psutil_path_returns_primary_ipv4_with_subnet():
    addrs = {"eth0": [_addr("192.168.1.50", "255.255.255.0")]}
    stats = {"eth0": _stats(isup=True)}
    with (
        patch("psutil.net_if_addrs", return_value=addrs),
        patch("psutil.net_if_stats", return_value=stats),
    ):
        result = network_utils._get_network_interfaces_psutil()
    assert result == [{"name": "eth0", "ip": "192.168.1.50", "netmask": "255.255.255.0", "subnet": "192.168.1.0/24"}]


def test_psutil_path_skips_loopback_linklocal_and_down():
    addrs = {
        "lo": [_addr("127.0.0.1", "255.0.0.0")],
        "linklocal": [_addr("169.254.10.20", "255.255.0.0")],
        "down_if": [_addr("10.0.0.5", "255.255.255.0")],
        "wlan0": [_addr("10.1.1.7", "255.255.255.0")],
    }
    stats = {
        "lo": _stats(isup=True),
        "linklocal": _stats(isup=True),
        "down_if": _stats(isup=False),
        "wlan0": _stats(isup=True),
    }
    with (
        patch("psutil.net_if_addrs", return_value=addrs),
        patch("psutil.net_if_stats", return_value=stats),
    ):
        result = network_utils._get_network_interfaces_psutil()
    names = {r["name"] for r in result}
    assert names == {"wlan0"}


def test_psutil_path_skips_non_ipv4_and_takes_first():
    addrs = {
        "eth0": [
            _addr("fe80::1", None, family=socket.AF_INET6),
            _addr("192.168.5.10", "255.255.255.0"),
            _addr("192.168.5.11", "255.255.255.0"),
        ]
    }
    stats = {"eth0": _stats(isup=True)}
    with (
        patch("psutil.net_if_addrs", return_value=addrs),
        patch("psutil.net_if_stats", return_value=stats),
    ):
        result = network_utils._get_network_interfaces_psutil()
    assert [r["ip"] for r in result] == ["192.168.5.10"]  # first IPv4 only


def test_get_network_interfaces_routes_to_psutil_on_win32():
    with (
        patch.object(network_utils.sys, "platform", "win32"),
        patch.object(network_utils, "_get_network_interfaces_psutil", return_value=[{"name": "x"}]) as mock,
    ):
        result = network_utils.get_network_interfaces()
    mock.assert_called_once()
    assert result == [{"name": "x"}]


def _fake_windows_psutil():
    """upstream #3121's host: one vmxnet3 NIC carrying three IPv4 addresses.

    "Local Area Connection" is here on purpose — it starts with ``lo``, so it
    is what EXCLUDED_INTERFACE_PREFIXES would eat if the Linux name filter were
    applied to Windows adapter names.
    """
    addrs = {
        "Ethernet0": [
            _addr("10.10.24.6", "255.255.255.0"),
            _addr("10.10.24.7", "255.255.255.0"),
            _addr("10.10.24.8", "255.255.255.0"),
        ],
        "Local Area Connection": [_addr("192.168.7.5", "255.255.255.0")],
    }
    stats = {
        "Ethernet0": _stats(True),
        "Local Area Connection": _stats(True),
    }
    return addrs, stats


def _patch_psutil(addrs, stats):
    """Both psutil calls the enumerator makes, as one context manager."""
    return patch.multiple(
        "psutil",
        net_if_addrs=lambda: addrs,
        net_if_stats=lambda: stats,
    )


class TestSecondaryAddresses:
    """upstream #3121: a NIC with several IPv4 addresses is several VP bind targets.

    The Virtual Printer needs one bind IP per printer. Linux gets one dropdown
    entry per alias from `ip -j addr show`; Windows and macOS have no `ip`, so
    everything they offer comes out of psutil.
    """

    def test_every_ipv4_on_an_interface_is_listed(self):
        addrs, stats = _fake_windows_psutil()
        with _patch_psutil(addrs, stats):
            entries = network_utils._psutil_ipv4_entries()

        eth0 = [e for e in entries if e["name"] == "Ethernet0"]
        assert [e["ip"] for e in eth0] == ["10.10.24.6", "10.10.24.7", "10.10.24.8"]
        # Position is the only alias signal on this path: first = primary.
        assert [e["is_alias"] for e in eth0] == [False, True, True]
        assert {e["subnet"] for e in eth0} == {"10.10.24.0/24"}

    def test_get_network_interfaces_still_returns_one_per_interface(self):
        """Discovery subnets and the support bundle want interfaces, not aliases."""
        addrs, stats = _fake_windows_psutil()
        with _patch_psutil(addrs, stats):
            result = network_utils._get_network_interfaces_psutil()

        assert [i["ip"] for i in result if i["name"] == "Ethernet0"] == ["10.10.24.6"]
        # The narrower shape this function has always returned.
        assert set(result[0]) == {"name", "ip", "netmask", "subnet"}

    @patch("backend.app.services.network_utils.sys")
    def test_windows_dropdown_offers_each_secondary_ip(self, mock_sys):
        """The actual bug: only one entry per NIC reached the bind dropdown."""
        mock_sys.platform = "win32"
        addrs, stats = _fake_windows_psutil()
        with _patch_psutil(addrs, stats):
            entries = network_utils.get_all_interface_ips()

        assert [e["ip"] for e in entries if e["name"] == "Ethernet0"] == [
            "10.10.24.6",
            "10.10.24.7",
            "10.10.24.8",
        ]

    @patch("backend.app.services.network_utils.sys")
    def test_windows_keeps_adapters_matching_a_linux_prefix(self, mock_sys):
        """EXCLUDED_INTERFACE_PREFIXES must not run against Windows names."""
        mock_sys.platform = "win32"
        addrs, stats = _fake_windows_psutil()
        with _patch_psutil(addrs, stats):
            entries = network_utils.get_all_interface_ips()

        assert "Local Area Connection" in {e["name"] for e in entries}

    @patch("backend.app.services.network_utils.sys")
    def test_linux_without_iproute2_gets_aliases_and_keeps_its_exclusions(self, mock_sys):
        """psutil replaces the ioctl fallback, so no-`ip` hosts see aliases too.

        The name exclusions still apply here — unlike Windows, these really are
        the local device names, and docker0 has no business in the dropdown.
        """
        mock_sys.platform = "linux"
        addrs = {
            "eth0": [
                _addr("192.168.1.100", "255.255.255.0"),
                _addr("192.168.1.101", "255.255.255.0"),
            ],
            "docker0": [_addr("172.17.0.1", "255.255.0.0")],
        }
        stats = {"eth0": _stats(True), "docker0": _stats(True)}

        with _patch_psutil(addrs, stats), patch.object(network_utils, "_IP_CMD", None):
            entries = network_utils.get_all_interface_ips()
            unfiltered = network_utils.get_all_interface_ips(include_excluded=True)

        assert [e["ip"] for e in entries] == ["192.168.1.100", "192.168.1.101"]
        assert "docker0" not in {e["name"] for e in entries}
        assert "docker0" in {e["name"] for e in unfiltered}

    @patch("backend.app.services.network_utils.sys")
    def test_ioctl_remains_the_last_resort(self, mock_sys):
        """A venv without psutil still enumerates, just without the aliases."""
        mock_sys.platform = "linux"
        with (
            patch.object(network_utils, "_IP_CMD", None),
            patch.object(network_utils, "_psutil_ipv4_entries", return_value=[]),
            patch.object(
                network_utils,
                "get_network_interfaces",
                return_value=[
                    {"name": "eth0", "ip": "192.168.1.100", "netmask": "255.255.255.0", "subnet": "192.168.1.0/24"}
                ],
            ),
        ):
            entries = network_utils.get_all_interface_ips()

        assert entries == [
            {
                "name": "eth0",
                "ip": "192.168.1.100",
                "netmask": "255.255.255.0",
                "subnet": "192.168.1.0/24",
                "is_alias": False,
                "label": "eth0",
            }
        ]

    @patch("backend.app.services.network_utils.sys")
    def test_adapter_order_is_preserved_for_source_ip_selection(self, mock_sys):
        """find_interface_for_ip() answers with the first match, so order matters.

        The MQTT bridge takes that answer as the source IP for the #1429
        rewrite and the SSDP proxy as its local interface. On a host with two
        adapters on one subnet, re-ordering the enumeration would silently
        re-pick both, so this path stays in psutil's adapter order rather than
        being sorted by name the way the iproute2 path is.
        """
        mock_sys.platform = "win32"
        addrs = {
            "Zeta": [_addr("10.10.24.6", "255.255.255.0")],
            "Alpha": [_addr("10.10.24.9", "255.255.255.0")],
        }
        stats = {"Zeta": _stats(True), "Alpha": _stats(True)}

        with _patch_psutil(addrs, stats):
            assert [e["name"] for e in network_utils.get_all_interface_ips()] == ["Zeta", "Alpha"]
            assert network_utils.find_interface_for_ip("10.10.24.200")["name"] == "Zeta"
