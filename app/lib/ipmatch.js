// app/lib/ipmatch.js
// Matching + resolving logic for Panorama IP Finder
// CommonJS module (require/module.exports), 4-space indents

const ipaddr = require("ipaddr.js");

// ------------ Helpers ------------
function asArray(x) {
    if (x === undefined || x === null) return [];
    return Array.isArray(x) ? x : [x];
}

function getEntryName(entry) {
    return entry?.["@_name"] || entry?.["@name"] || entry?.name || null;
}

function normalizeTarget(target) {
    if (!target || typeof target !== "string") {
        throw new Error("Missing IP");
    }

    const t = target.trim();

    if (t.includes("/")) {
        const [ip, pref] = t.split("/");
        if (!ipaddr.isValid(ip)) {
            throw new Error(`Invalid CIDR IP: ${ip}`);
        }

        const prefix = Number(pref);
        if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
            throw new Error(`Invalid CIDR prefix: ${pref}`);
        }

        return { kind: "cidr", ip: ipaddr.parse(ip), prefix };
    }

    if (!ipaddr.isValid(t)) {
        throw new Error(`Invalid IP: ${t}`);
    }

    return { kind: "ip", ip: ipaddr.parse(t) };
}

function toInt(ip) {
    // IPv4 only here
    return ip.toByteArray().reduce((acc, n) => (acc * 256) + n, 0);
}

// NEW: support dotted netmask suffixes like 4.2.2.2/255.255.255.255
function netmaskToPrefix(netmaskStr) {
    if (!netmaskStr || typeof netmaskStr !== "string") return null;
    const s = netmaskStr.trim();
    if (!ipaddr.isValid(s)) return null;

    const bytes = ipaddr.parse(s).toByteArray(); // [255,255,255,0]
    let bits = 0;
    let seenZero = false;

    for (const b of bytes) {
        for (let i = 7; i >= 0; i--) {
            const bit = (b >> i) & 1;
            if (bit === 1) {
                if (seenZero) {
                    // 11101111 kind of mask => invalid
                    return null;
                }
                bits++;
            } else {
                seenZero = true;
            }
        }
    }

    return bits;
}

function ipMatchesTarget(value, target) {
    if (!value || typeof value !== "string") return false;

    const v = value.trim();
    if (!v || v === "any") return false;

    // IP range: A-B
    if (v.includes("-")) {
        const [a, b] = v.split("-").map((s) => s.trim());
        if (!ipaddr.isValid(a) || !ipaddr.isValid(b)) return false;

        const A = ipaddr.parse(a);
        const B = ipaddr.parse(b);

        const aInt = toInt(A);
        const bInt = toInt(B);

        if (target.kind === "ip") {
            const tInt = toInt(target.ip);
            return aInt <= tInt && tInt <= bInt;
        } else {
            // CIDR overlap with range (bounds check)
            const prefix = target.prefix;
            const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
            const net = (toInt(target.ip) & mask) >>> 0;
            const broadcast = (net + ((1 << (32 - prefix)) - 1)) >>> 0;
            return !(bInt < net || aInt > broadcast);
        }
    }

    // CIDR-ish value: 1.2.3.4/32 OR 1.2.3.4/255.255.255.255
    if (v.includes("/")) {
        const [ip, pref] = v.split("/");
        if (!ipaddr.isValid(ip)) return false;

        const net = ipaddr.parse(ip);

        let prefix = Number(pref);
        if (!Number.isFinite(prefix)) {
            prefix = netmaskToPrefix(pref);
        }
        if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return false;

        if (target.kind === "ip") {
            return target.ip.match(net, prefix);
        }

        const aContainsB = (aIp, aPref, bIp, bPref) =>
            bIp.match(aIp, aPref) && aPref <= bPref;

        return (
            aContainsB(target.ip, target.prefix, net, prefix) ||
            aContainsB(net, prefix, target.ip, target.prefix)
        );
    }

    // Single IP value
    if (ipaddr.isValid(v)) {
        const ip = ipaddr.parse(v);
        if (target.kind === "ip") {
            return ip.toString() === target.ip.toString();
        }
        return ip.match(target.ip, target.prefix);
    }

    // fqdn / unknown string
    return false;
}

// resolves objects / nested groups into concrete address strings
function resolveMember(scope, member, maps, depth = 0, seen = new Set()) {
    if (depth > 25) return [];
    const key = `${scope}::${member}`;
    if (seen.has(key)) return [];
    seen.add(key);

    if (!member || typeof member !== "string") return [];
    const m = member.trim();
    if (!m || m === "any") return [];

    // literal-ish (ip, cidr, range)
    if (ipaddr.isValid(m) || m.includes("/") || m.includes("-")) return [m];

    const addrMap = maps.addr.get(scope);
    const sharedAddr = maps.addr.get("shared");
    const grpMap = maps.grp.get(scope);
    const sharedGrp = maps.grp.get("shared");

    // address object lookup: prefer scope, fallback shared
    const val = (addrMap && addrMap.get(m)) || (sharedAddr && sharedAddr.get(m));
    if (val) return [val];

    // group lookup: prefer scope, fallback shared
    const members = (grpMap && grpMap.get(m)) || (sharedGrp && sharedGrp.get(m));
    if (!members) return [];

    const out = [];
    for (const child of members) {
        out.push(...resolveMember(scope, String(child), maps, depth + 1, seen));
    }
    return out;
}

/**
 * Build matching name sets:
 *   nameSets.get(scope) => Set of address object names whose VALUES match the target
 */
function buildMatchingAddrNameSets(maps, target) {
    const sets = new Map();

    for (const [scope, addrMap] of maps.addr.entries()) {
        const s = new Set();
        for (const [name, value] of addrMap.entries()) {
            if (ipMatchesTarget(String(value), target)) {
                s.add(name);
            }
        }
        sets.set(scope, s);
    }

    return sets;
}

/**
 * Find matching rules for a target IP/CIDR, scanning:
 * - shared rulebase, pre-rulebase, post-rulebase
 * - each device-group rulebase, pre-rulebase, post-rulebase
 *
 * Requires maps from buildObjectMaps(root):
 *   maps.addr: Map(scope -> Map(name -> value))
 *   maps.grp:  Map(scope -> Map(name -> [members...]))
 */
function findMatchingRules(root, targetIp, maps) {
    const target = normalizeTarget(targetIp);
    const results = [];

    const config = root?.config || root;
    const nameSets = buildMatchingAddrNameSets(maps, target);

    function checkRule(scopeKey, scopeLabel, rulebaseLabel, ruleEntry) {
        const ruleName = getEntryName(ruleEntry) || "unnamed-rule";
        const srcMembers = asArray(ruleEntry?.source?.member).map(String);
        const dstMembers = asArray(ruleEntry?.destination?.member).map(String);

        const checkSide = (sideName, members) => {
            const scopeSet = nameSets.get(scopeKey) || new Set();
            const sharedSet = nameSets.get("shared") || new Set();

            for (const mem of members) {
                // 1) Quick name match: member is an address object NAME that matches needle
                if (scopeSet.has(mem) || sharedSet.has(mem)) {
                    results.push({
                        device_group: scopeLabel,
                        rulebase: rulebaseLabel,
                        rule: ruleName,
                        matched_on: sideName,
                        object: mem,
                        resolved_value: "(matched by object name)",
                    });
                    continue;
                }

                // 2) Resolve groups/objects into concrete values
                const resolved = resolveMember(scopeKey, mem, maps);
                const candidates = resolved.length ? resolved : [mem];

                // 3) Match literals/ranges/cidrs/netmasks
                for (const val of candidates) {
                    if (ipMatchesTarget(String(val), target)) {
                        results.push({
                            device_group: scopeLabel,
                            rulebase: rulebaseLabel,
                            rule: ruleName,
                            matched_on: sideName,
                            object: mem,
                            resolved_value: String(val),
                        });
                    }
                }
            }
        };

        checkSide("source", srcMembers);
        checkSide("destination", dstMembers);
    }

    // ---- Top-level shared rulebases ----
    const topShared = config?.shared;
    if (topShared) {
        for (const r of asArray(topShared?.rulebase?.security?.rules?.entry)) {
            checkRule("shared", "shared", "rulebase", r);
        }
        for (const r of asArray(topShared?.["pre-rulebase"]?.security?.rules?.entry)) {
            checkRule("shared", "shared", "pre-rulebase", r);
        }
        for (const r of asArray(topShared?.["post-rulebase"]?.security?.rules?.entry)) {
            checkRule("shared", "shared", "post-rulebase", r);
        }
    }

    // ---- Devices (exports vary: config.devices OR config.mgt-config.devices) ----
    const devices = [
        ...asArray(config?.devices?.entry),
        ...asArray(config?.["mgt-config"]?.devices?.entry),
    ];

    for (const dev of devices) {
        // some exports also have shared rulebases under each device
        const shared = dev?.shared;
        if (shared) {
            for (const r of asArray(shared?.rulebase?.security?.rules?.entry)) {
                checkRule("shared", "shared", "rulebase", r);
            }
            for (const r of asArray(shared?.["pre-rulebase"]?.security?.rules?.entry)) {
                checkRule("shared", "shared", "pre-rulebase", r);
            }
            for (const r of asArray(shared?.["post-rulebase"]?.security?.rules?.entry)) {
                checkRule("shared", "shared", "post-rulebase", r);
            }
        }

        // device-group rules
        for (const dg of asArray(dev?.["device-group"]?.entry)) {
            const dgName = getEntryName(dg) || "unknown-dg";
            const scopeKey = `dg:${dgName}`;
            const scopeLabel = `device-group:${dgName}`;

            for (const r of asArray(dg?.rulebase?.security?.rules?.entry)) {
                checkRule(scopeKey, scopeLabel, "rulebase", r);
            }
            for (const r of asArray(dg?.["pre-rulebase"]?.security?.rules?.entry)) {
                checkRule(scopeKey, scopeLabel, "pre-rulebase", r);
            }
            for (const r of asArray(dg?.["post-rulebase"]?.security?.rules?.entry)) {
                checkRule(scopeKey, scopeLabel, "post-rulebase", r);
            }
        }
    }

    return results;
}

module.exports = {
    normalizeTarget,
    ipMatchesTarget,
    resolveMember,
    findMatchingRules,
    netmaskToPrefix,
};