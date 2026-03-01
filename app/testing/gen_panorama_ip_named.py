#!/usr/bin/env python3
"""
gen_panorama_ip_named.py

Generate a large Panorama-style XML config with:
- Sequential IPv4 address objects
- Name format: test-addr_obj-<ip>
- Value: <ip>
- Any/any allow rules
- Stops at target file size (default 25 MB)

Fixes:
- Default base network is now 10.0.0.0/8 (avoids running out of IPs)
- Optional --max-addrs cap to prevent runaway generation
"""

import argparse
import ipaddress
import os
import time


def write_line(f, s: str) -> None:
    f.write(s)
    if not s.endswith("\n"):
        f.write("\n")


def current_size(path: str) -> int:
    return os.path.getsize(path) if os.path.exists(path) else 0


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", required=True, help="Output XML file")
    parser.add_argument("--size-mb", type=float, default=25.0, help="Target size in MB (default 25)")
    parser.add_argument("--base-network", default="10.0.0.0/8",
                        help="IPv4 network to allocate addresses from (default 10.0.0.0/8)")
    parser.add_argument("--dg", default="DG_TEST", help="Device Group name")
    parser.add_argument("--addr-prefix", default="test-addr_obj", help="Address object name prefix")
    parser.add_argument("--rule-prefix", default="test-rule", help="Security rule name prefix")
    parser.add_argument("--flush-every", type=int, default=2000, help="Flush interval (entries)")
    parser.add_argument("--max-addrs", type=int, default=0,
                        help="Optional cap on address objects (0 = no cap)")
    parser.add_argument("--addr-fill-percent", type=float, default=70.0,
                        help="Percent of target size to dedicate to address objects before rules (default 70)")
    args = parser.parse_args()

    target_bytes = int(args.size_mb * 1024 * 1024)
    addr_target_bytes = int(target_bytes * (args.addr_fill_percent / 100.0))

    out_path = args.out
    if os.path.exists(out_path):
        os.remove(out_path)

    network = ipaddress.ip_network(args.base_network, strict=False)
    ip_iter = network.hosts()

    addr_count = 0
    rule_count = 0
    t0 = time.time()

    with open(out_path, "w", encoding="utf-8", newline="\n") as f:
        # Header
        write_line(f, '<?xml version="1.0" encoding="utf-8"?>')
        write_line(f, "<config>")
        write_line(f, "  <shared>")
        write_line(f, "    <address>")

        # Address objects until addr_target_bytes (or max-addrs)
        while current_size(out_path) < addr_target_bytes:
            if args.max_addrs and addr_count >= args.max_addrs:
                break

            try:
                ip = str(next(ip_iter))
            except StopIteration:
                raise RuntimeError(
                    f"Ran out of IPs in base network {args.base_network}. "
                    f"Use a larger network like 10.0.0.0/8."
                )

            name = f"{args.addr_prefix}-{ip}"
            write_line(f, f'      <entry name="{name}"><ip-netmask>{ip}</ip-netmask></entry>')

            addr_count += 1
            if addr_count % args.flush_every == 0:
                f.flush()

        # Close shared address section
        write_line(f, "    </address>")
        write_line(f, "  </shared>")

        # Device-group rulebase skeleton
        write_line(f, "  <devices>")
        write_line(f, '    <entry name="localhost.localdomain">')
        write_line(f, "      <device-group>")
        write_line(f, f'        <entry name="{args.dg}">')
        write_line(f, "          <post-rulebase>")
        write_line(f, "            <security>")
        write_line(f, "              <rules>")

        # Any/any allow rules until we hit target size
        while current_size(out_path) < target_bytes:
            rname = f"{args.rule_prefix}-{rule_count:07d}"
            write_line(f, f'                <entry name="{rname}">')
            write_line(f, "                  <from><member>any</member></from>")
            write_line(f, "                  <to><member>any</member></to>")
            write_line(f, "                  <source><member>any</member></source>")
            write_line(f, "                  <destination><member>any</member></destination>")
            write_line(f, "                  <application><member>any</member></application>")
            write_line(f, "                  <service><member>any</member></service>")
            write_line(f, "                  <action>allow</action>")
            write_line(f, "                </entry>")

            rule_count += 1
            if rule_count % 1000 == 0:
                f.flush()

        # Close rulebase + XML
        write_line(f, "              </rules>")
        write_line(f, "            </security>")
        write_line(f, "          </post-rulebase>")
        write_line(f, "        </entry>")
        write_line(f, "      </device-group>")
        write_line(f, "    </entry>")
        write_line(f, "  </devices>")
        write_line(f, "</config>")
        f.flush()

    elapsed = time.time() - t0
    final_size = current_size(out_path)

    print("Done.")
    print(f"File: {out_path}")
    print(f"Size: {final_size / (1024*1024):.2f} MB (target {args.size_mb:.2f} MB)")
    print(f"Address objects: {addr_count}")
    print(f"Security rules: {rule_count}")
    print(f"Time: {elapsed:.2f}s")


if __name__ == "__main__":
    main()