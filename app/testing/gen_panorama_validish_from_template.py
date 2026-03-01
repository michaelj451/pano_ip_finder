#!/usr/bin/env python3
"""
gen_panorama_validish_from_template.py

Goal: generate a large (~25MB) Panorama-export-shaped XML config using a built-in skeleton template
and inject lots of:
  - shared address objects (name includes IP)
  - shared pre-rulebase any/any allow rules
Optional:
  - device-group pre-rulebase any/any allow rules

This is intentionally "template-driven" so the structure resembles a real Panorama export.

Examples:
  python3 gen_panorama_validish_from_template.py --out test_config.xml
  python3 gen_panorama_validish_from_template.py --out test_config.xml --size-mb 25 --base-network 10.0.0.0/8
  python3 gen_panorama_validish_from_template.py --out test_config.xml --include-dg --dg dg-3
"""

from __future__ import annotations

import argparse
import ipaddress
import os
import time


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
    <!-- injected: address objects -->
    <address>
"""

TEMPLATE_MID = """    </address>

    <!-- injected: shared pre-rulebase rules -->
    <pre-rulebase>
      <security>
        <rules>
"""

TEMPLATE_AFTER_SHARED_RULES = """        </rules>
      </security>
    </pre-rulebase>

    <!-- minimal placeholders seen in many exports -->
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


def fsize(path: str) -> int:
    return os.path.getsize(path) if os.path.exists(path) else 0


def safe_rule_name(prefix: str, n: int) -> str:
    # Panorama rule names can include spaces; keep it boring.
    return f"{prefix} {n}"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="Output XML file path")
    ap.add_argument("--size-mb", type=float, default=25.0, help="Target size in MB (default 25)")
    ap.add_argument("--base-network", default="10.0.0.0/8", help="IPv4 space used for sequential objects")
    ap.add_argument("--addr-prefix", default="test-addr_obj", help="Address object prefix (name includes IP)")
    ap.add_argument("--shared-rule-prefix", default="test rule shared", help="Shared rule name prefix")
    ap.add_argument("--include-dg", action="store_true", help="Also generate a device-group with rules")
    ap.add_argument("--dg", default="dg-test", help="Device-group name if --include-dg")
    ap.add_argument("--dg-rule-prefix", default="test rule dg", help="Device-group rule name prefix")
    ap.add_argument("--addr-fill-percent", type=float, default=70.0,
                    help="Percent of size used for address objects before rules (default 70)")
    ap.add_argument("--flush-every", type=int, default=2000, help="Flush interval")
    args = ap.parse_args()

    target_bytes = int(args.size_mb * 1024 * 1024)
    addr_target_bytes = int(target_bytes * (args.addr_fill_percent / 100.0))

    if os.path.exists(args.out):
        os.remove(args.out)

    net = ipaddress.ip_network(args.base_network, strict=False)
    ip_iter = net.hosts()

    addr_count = 0
    shared_rule_count = 0
    dg_rule_count = 0

    t0 = time.time()

    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        # --- Write template prefix up to <shared><address> ---
        f.write(TEMPLATE_PREFIX)

        # --- Inject address objects until addr_target_bytes ---
        while fsize(args.out) < addr_target_bytes:
            try:
                ip = str(next(ip_iter))
            except StopIteration:
                raise RuntimeError(
                    f"Ran out of IPs in {args.base_network}. Use a larger network (e.g. 10.0.0.0/8)."
                )

            # Name includes IP exactly as requested: test-addr_obj-10.1.1.1
            name = f"{args.addr_prefix}-{ip}"
            write_line(f, f'      <entry name="{name}"><ip-netmask>{ip}</ip-netmask></entry>')

            addr_count += 1
            if addr_count % args.flush_every == 0:
                f.flush()

        # --- Continue template into shared pre-rulebase rules ---
        f.write(TEMPLATE_MID)

        # --- Inject shared rules until we hit overall target (or until DG section needs room) ---
        # If include-dg, leave a little room for the device-group section.
        reserve_for_devices = 0.5 * 1024 * 1024 if args.include_dg else 0  # ~0.5MB reserved
        while fsize(args.out) < (target_bytes - reserve_for_devices):
            shared_rule_count += 1
            rname = safe_rule_name(args.shared_rule_prefix, shared_rule_count)

            write_line(f, f'          <entry name="{rname}">')
            write_line(f, "            <target><negate>no</negate></target>")
            write_line(f, "            <to><member>any</member></to>")
            write_line(f, "            <from><member>any</member></from>")
            write_line(f, "            <source><member>any</member></source>")
            write_line(f, "            <destination><member>any</member></destination>")
            write_line(f, "            <source-user><member>any</member></source-user>")
            write_line(f, "            <category><member>any</member></category>")
            write_line(f, "            <application><member>any</member></application>")
            write_line(f, "            <service><member>application-default</member></service>")
            write_line(f, "            <action>allow</action>")
            write_line(f, "            <log-start>no</log-start>")
            write_line(f, "            <log-end>yes</log-end>")
            write_line(f, "          </entry>")

            if shared_rule_count % 1000 == 0:
                f.flush()

        # --- Close shared rules and shared section ---
        f.write(TEMPLATE_AFTER_SHARED_RULES)

        # --- Optional: include a device-group section (still template-driven) ---
        if args.include_dg:
            f.write(TEMPLATE_DEVICES_PREFIX.format(DG_NAME=args.dg))

            # Add DG rules (any/any allow). Keep generating until we hit target.
            while fsize(args.out) < target_bytes:
                dg_rule_count += 1
                rname = safe_rule_name(f"{args.dg_rule_prefix}-{args.dg}", dg_rule_count)

                write_line(f, f'                <entry name="{rname}">')
                write_line(f, "                  <target><negate>no</negate></target>")
                write_line(f, "                  <to><member>any</member></to>")
                write_line(f, "                  <from><member>any</member></from>")
                write_line(f, "                  <source><member>any</member></source>")
                write_line(f, "                  <destination><member>any</member></destination>")
                write_line(f, "                  <source-user><member>any</member></source-user>")
                write_line(f, "                  <category><member>any</member></category>")
                write_line(f, "                  <application><member>any</member></application>")
                write_line(f, "                  <service><member>application-default</member></service>")
                write_line(f, "                  <action>allow</action>")
                write_line(f, "                  <log-start>no</log-start>")
                write_line(f, "                  <log-end>yes</log-end>")
                write_line(f, "                </entry>")

                if dg_rule_count % 1000 == 0:
                    f.flush()

            f.write(TEMPLATE_DEVICES_SUFFIX)

        # --- Close config ---
        f.write(TEMPLATE_SUFFIX)
        f.flush()

    elapsed = time.time() - t0
    final_bytes = fsize(args.out)

    print("Done.")
    print(f"File: {args.out}")
    print(f"Size: {final_bytes / (1024 * 1024):.2f} MB (target {args.size_mb:.2f} MB)")
    print(f"Address objects: {addr_count}")
    print(f"Shared pre-rule rules: {shared_rule_count}")
    if args.include_dg:
        print(f"DG pre-rule rules: {dg_rule_count}")
    print(f"Time: {elapsed:.2f}s")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())