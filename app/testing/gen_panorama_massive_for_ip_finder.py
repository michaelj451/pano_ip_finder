#!/usr/bin/env python3
"""
gen_panorama_massive_for_ip_finder.py

Generate a massive Panorama-export-shaped XML config for stress-testing "Panorama IP Finder".

Features:
- Address objects with sequential IPv4 hosts from a base network
  name: test-addr_obj-10.0.0.1
  value: 10.0.0.1
- Shared pre-rulebase rules that reference MANY of these objects
- Optional device-group rulebase rules, also referencing objects
- You can over-generate rules; this is not intended for production import.

Examples:
  python3 gen_panorama_massive_for_ip_finder.py --out big.xml --addr-count 200000 --rules 200000 --src-members 10 --dst-members 10
  python3 gen_panorama_massive_for_ip_finder.py --out big.xml --addr-count 500000 --rules 500000 --src-members 25 --dst-members 25 --base-network 10.0.0.0/8
  python3 gen_panorama_massive_for_ip_finder.py --out big.xml --addr-count 200000 --rules 100000 --src-members 50 --dst-members 50 --include-dg --dg dg-3 --dg-rules 50000
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import time
from typing import List


TEMPLATE_PREFIX = """<?xml version="1.0"?>
<config version="11.2.0" urldb="paloaltonetworks" detail-version="11.2.10">
  <mgt-config>
    <devices/>
    <users>
      <entry name="admin">
        <permissions>
          <role-based>
            <superuser>yes</superuser>
          </role-based>
        </permissions>
      </entry>
    </users>
    <password-complexity>
      <enabled>yes</enabled>
      <minimum-length>8</minimum-length>
    </password-complexity>
  </mgt-config>

  <shared>
    <address>
"""

TEMPLATE_SHARED_RULES_PREFIX = """    </address>

    <pre-rulebase>
      <security>
        <rules>
"""

TEMPLATE_SHARED_RULES_SUFFIX_AND_SHARED_CLOSE = """        </rules>
      </security>
    </pre-rulebase>

    <tag/>
    <address-group/>
    <service/>
    <post-rulebase/>
  </shared>
"""

TEMPLATE_DEVICES_PREFIX = """
  <devices>
    <entry name="localhost.localdomain">
      <deviceconfig>
        <system>
          <hostname>synthetic-panorama</hostname>
          <timezone>US/Central</timezone>
        </system>
      </deviceconfig>
      <device-group>
        <entry name="{DG_NAME}">
          <devices/>
          <pre-rulebase>
            <security>
              <rules>
"""

TEMPLATE_DEVICES_SUFFIX = """              </rules>
            </security>
          </pre-rulebase>
          <post-rulebase/>
          <address/>
          <address-group/>
        </entry>
      </device-group>
      <template/>
      <template-stack/>
      <log-collector/>
      <log-collector-group/>
    </entry>
  </devices>
"""

TEMPLATE_SUFFIX = """</config>
"""


def write_line(f, s: str) -> None:
    f.write(s)
    if not s.endswith("\n"):
        f.write("\n")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Output XML file path")
    ap.add_argument("--base-network", default="10.0.0.0/8", help="IPv4 space used for sequential objects")
    ap.add_argument("--addr-prefix", default="test-addr_obj", help="Address object prefix (name includes IP)")
    ap.add_argument("--addr-count", type=int, default=200_000, help="How many address objects to generate")
    ap.add_argument("--rules", type=int, default=100_000, help="How many shared rules to generate")
    ap.add_argument("--src-members", type=int, default=10, help="How many source members per rule")
    ap.add_argument("--dst-members", type=int, default=10, help="How many destination members per rule")
    ap.add_argument("--shared-rule-prefix", default="test rule shared", help="Shared rule name prefix")
    ap.add_argument("--include-dg", action="store_true", help="Also generate device-group rules")
    ap.add_argument("--dg", default="dg-test", help="Device-group name if --include-dg")
    ap.add_argument("--dg-rules", type=int, default=0, help="How many DG rules to generate (if include-dg)")
    ap.add_argument("--dg-rule-prefix", default="test rule dg", help="DG rule name prefix")
    ap.add_argument("--flush-every", type=int, default=2000, help="Flush interval (entries)")
    args = ap.parse_args()

    if args.src_members < 0 or args.dst_members < 0:
        raise SystemExit("--src-members and --dst-members must be >= 0")
    if args.addr_count <= 0:
        raise SystemExit("--addr-count must be > 0")
    if args.rules < 0:
        raise SystemExit("--rules must be >= 0")

    if os.path.exists(args.out):
        os.remove(args.out)

    net = ipaddress.ip_network(args.base_network, strict=False)
    ip_iter = net.hosts()

    ips: List[str] = []
    t0 = time.time()

    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        # --- Write template prefix ---
        f.write(TEMPLATE_PREFIX)

        # --- Generate address objects ---
        for i in range(args.addr_count):
            try:
                ip = str(next(ip_iter))
            except StopIteration:
                raise RuntimeError(
                    f"Ran out of IPs in {args.base_network} after {i} objects. "
                    f"Use a larger network (e.g. 10.0.0.0/8)."
                )

            ips.append(ip)
            name = f"{args.addr_prefix}-{ip}"
            write_line(f, f'      <entry name="{name}"><ip-netmask>{ip}</ip-netmask></entry>')

            if (i + 1) % args.flush_every == 0:
                f.flush()

        # --- Shared rules prefix ---
        f.write(TEMPLATE_SHARED_RULES_PREFIX)

        # --- Generate shared rules referencing objects heavily ---
        # Cycle through object list so everything gets referenced repeatedly.
        n_ips = len(ips)
        if n_ips == 0:
            raise RuntimeError("No IPs generated (unexpected).")

        cursor = 0
        for r in range(args.rules):
            rname = f"{args.shared_rule_prefix} {r + 1}"
            write_line(f, f'          <entry name="{rname}">')
            write_line(f, "            <target><negate>no</negate></target>")
            write_line(f, "            <to><member>any</member></to>")
            write_line(f, "            <from><member>any</member></from>")

            # Source members
            write_line(f, "            <source>")
            for _ in range(args.src_members):
                ip = ips[cursor % n_ips]
                cursor += 1
                write_line(f, f"              <member>{args.addr_prefix}-{ip}</member>")
            write_line(f, "            </source>")

            # Destination members
            write_line(f, "            <destination>")
            for _ in range(args.dst_members):
                ip = ips[cursor % n_ips]
                cursor += 1
                write_line(f, f"              <member>{args.addr_prefix}-{ip}</member>")
            write_line(f, "            </destination>")

            write_line(f, "            <source-user><member>any</member></source-user>")
            write_line(f, "            <category><member>any</member></category>")
            write_line(f, "            <application><member>any</member></application>")
            write_line(f, "            <service><member>application-default</member></service>")
            write_line(f, "            <action>allow</action>")
            write_line(f, "            <log-start>no</log-start>")
            write_line(f, "            <log-end>yes</log-end>")
            write_line(f, "          </entry>")

            if (r + 1) % 500 == 0:
                f.flush()

        # Close shared rules + shared section
        f.write(TEMPLATE_SHARED_RULES_SUFFIX_AND_SHARED_CLOSE)

        # --- Optional device-group rules (more references, more fun) ---
        if args.include_dg:
            dg_rules = args.dg_rules if args.dg_rules > 0 else args.rules // 10
            f.write(TEMPLATE_DEVICES_PREFIX.format(DG_NAME=args.dg))

            for r in range(dg_rules):
                rname = f"{args.dg_rule_prefix}-{args.dg} {r + 1}"
                write_line(f, f'                <entry name="{rname}">')
                write_line(f, "                  <target><negate>no</negate></target>")
                write_line(f, "                  <to><member>any</member></to>")
                write_line(f, "                  <from><member>any</member></from>")

                write_line(f, "                  <source>")
                for _ in range(args.src_members):
                    ip = ips[cursor % n_ips]
                    cursor += 1
                    write_line(f, f"                    <member>{args.addr_prefix}-{ip}</member>")
                write_line(f, "                  </source>")

                write_line(f, "                  <destination>")
                for _ in range(args.dst_members):
                    ip = ips[cursor % n_ips]
                    cursor += 1
                    write_line(f, f"                    <member>{args.addr_prefix}-{ip}</member>")
                write_line(f, "                  </destination>")

                write_line(f, "                  <source-user><member>any</member></source-user>")
                write_line(f, "                  <category><member>any</member></category>")
                write_line(f, "                  <application><member>any</member></application>")
                write_line(f, "                  <service><member>application-default</member></service>")
                write_line(f, "                  <action>allow</action>")
                write_line(f, "                  <log-start>no</log-start>")
                write_line(f, "                  <log-end>yes</log-end>")
                write_line(f, "                </entry>")

                if (r + 1) % 500 == 0:
                    f.flush()

            f.write(TEMPLATE_DEVICES_SUFFIX)

        # Close config
        f.write(TEMPLATE_SUFFIX)
        f.flush()

    elapsed = time.time() - t0
    final_mb = os.path.getsize(args.out) / (1024 * 1024)

    print("Done.")
    print(f"File: {args.out}")
    print(f"Size: {final_mb:.2f} MB")
    print(f"Address objects: {args.addr_count}")
    print(f"Shared rules: {args.rules} (src {args.src_members}, dst {args.dst_members})")
    if args.include_dg:
        dg_rules = args.dg_rules if args.dg_rules > 0 else args.rules // 10
        print(f"DG rules: {dg_rules} (src {args.src_members}, dst {args.dst_members})")
    print(f"Time: {elapsed:.2f}s")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())