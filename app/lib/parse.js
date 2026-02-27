// app/lib/parse.js
const { normalizeTarget, ipMatchesTarget } = require("./ipmatch");

// ------------ Helpers ------------
function asArray(x) {
    if (x === undefined || x === null) return [];
    return Array.isArray(x) ? x : [x];
}

function getEntryName(entry) {
    return entry?.["@_name"] || entry?.["@name"] || entry?.name || null;
}

/**
 * Build maps:
 *   addr[scope][name] = ip-netmask|ip-range|fqdn
 *   grp[scope][name] = [members...]
 */
function buildObjectMaps(root) {
    const maps = { addr: new Map(), grp: new Map() };

    function ensure(scope) {
        if (!maps.addr.has(scope)) maps.addr.set(scope, new Map());
        if (!maps.grp.has(scope)) maps.grp.set(scope, new Map());
    }

    function addAddr(scope, name, value) {
        if (!name || !value) return;
        ensure(scope);
        maps.addr.get(scope).set(name, String(value).trim());
    }

    function addGrp(scope, name, members) {
        if (!name) return;
        ensure(scope);
        maps.grp.get(scope).set(name, members || []);
    }

    const config = root?.config || root;

    // ✅ Top-level shared objects
    const topShared = config?.shared;
    if (topShared) {
        const scope = "shared";
        ensure(scope);

        for (const a of asArray(topShared?.address?.entry)) {
            const name = getEntryName(a);
            const value = a?.["ip-netmask"] || a?.["ip-range"] || a?.fqdn;
            if (value) addAddr(scope, name, value);
        }

        for (const g of asArray(topShared?.["address-group"]?.entry)) {
            const name = getEntryName(g);
            const members = asArray(g?.static?.member).map(String);
            addGrp(scope, name, members);
        }
    }

    // ✅ Panorama exports often place devices under either config.devices or mgt-config.devices
    const devices = [
        ...asArray(config?.devices?.entry),
        ...asArray(config?.["mgt-config"]?.devices?.entry),
    ];

    for (const dev of devices) {
        // Shared objects under devices.entry.shared (some exports do this)
        const shared = dev?.shared;
        if (shared) {
            const scope = "shared";
            ensure(scope);

            for (const a of asArray(shared?.address?.entry)) {
                const name = getEntryName(a);
                const value = a?.["ip-netmask"] || a?.["ip-range"] || a?.fqdn;
                if (value) addAddr(scope, name, value);
            }

            for (const g of asArray(shared?.["address-group"]?.entry)) {
                const name = getEntryName(g);
                const members = asArray(g?.static?.member).map(String);
                addGrp(scope, name, members);
            }
        }

        // Device-group objects
        for (const dg of asArray(dev?.["device-group"]?.entry)) {
            const dgName = getEntryName(dg) || "unknown-dg";
            const scope = `dg:${dgName}`;
            ensure(scope);

            for (const a of asArray(dg?.address?.entry)) {
                const name = getEntryName(a);
                const value = a?.["ip-netmask"] || a?.["ip-range"] || a?.fqdn;
                if (value) addAddr(scope, name, value);
            }

            for (const g of asArray(dg?.["address-group"]?.entry)) {
                const name = getEntryName(g);
                const members = asArray(g?.static?.member).map(String);
                addGrp(scope, name, members);
            }
        }
    }

    return maps;
}

function resolveMember(scope, member, maps, depth = 0, seen = new Set()) {
    // resolves objects / nested groups into concrete address strings
    if (depth > 25) return [];
    const key = `${scope}::${member}`;
    if (seen.has(key)) return [];
    seen.add(key);

    if (!member || typeof member !== "string") return [];
    const m = member.trim();
    if (!m || m === "any") return [];

    // literal-ish
    if (m.includes("/") || m.includes("-")) return [m];

    // Try shared + scope address objects
    const addrMap = maps.addr.get(scope);
    const sharedAddr = maps.addr.get("shared");

    const val = (addrMap && addrMap.get(m)) || (sharedAddr && sharedAddr.get(m));
    if (val) return [val];

    // Then groups (scope + shared)
    const grpMap = maps.grp.get(scope);
    const sharedGrp = maps.grp.get("shared");

    const members = (grpMap && grpMap.get(m)) || (sharedGrp && sharedGrp.get(m));
    if (!members) return [];

    const out = [];
    for (const child of members) {
        out.push(...resolveMember(scope, String(child), maps, depth + 1, seen));
    }
    return out;
}

/**
 * Find matches of targetIp (IP or CIDR) across:
 *   - top-level shared pre/post (and rulebase if present)
 *   - per-device shared pre/post (and rulebase if present)
 *   - all device-group pre/post (and rulebase if present)
 *
 * mode:
 *   - "overlap"   : CIDR overlaps CIDR/range
 *   - "contained" : CIDR must be fully contained in CIDR/range
 */
function findMatchingRules(root, targetIp, mode = "overlap") {
    const target = normalizeTarget(targetIp);
    const maps = buildObjectMaps(root);
    const results = [];

    const config = root?.config || root;

    function checkRule(scopeKey, scopeLabel, rulebaseLabel, ruleEntry) {
        const ruleName = getEntryName(ruleEntry) || "unnamed-rule";
        const srcMembers = asArray(ruleEntry?.source?.member).map(String);
        const dstMembers = asArray(ruleEntry?.destination?.member).map(String);

        function checkSide(sideName, members) {
            for (const mem of members) {
                const resolved = resolveMember(scopeKey, mem, maps);
                const candidates = resolved.length ? resolved : [mem];

                for (const val of candidates) {
                    if (ipMatchesTarget(val, target, mode)) {
                        results.push({
                            device_group: scopeLabel,
                            rulebase: rulebaseLabel,
                            rule: ruleName,
                            matched_on: sideName,
                            object: mem,
                            resolved_value: val,
                        });
                    }
                }
            }
        }

        checkSide("source", srcMembers);
        checkSide("destination", dstMembers);
    }

    // ✅ Top-level shared rulebases
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

    // ✅ Devices
    const devices = [
        ...asArray(config?.devices?.entry),
        ...asArray(config?.["mgt-config"]?.devices?.entry),
    ];

    for (const dev of devices) {
        // per-device shared rules (some exports have this)
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
    asArray,
    getEntryName,
    buildObjectMaps,
    resolveMember,
    findMatchingRules,
};