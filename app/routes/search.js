// app/routes/search.js

const express = require("express");
const { loadAndParseConfig } = require("../lib/config");
const { buildObjectMaps } = require("../lib/parse");
const { ipMatches, parseValue } = require("../lib/ipmatch");

const router = express.Router();

function asArray(x) {
    if (x === undefined || x === null) return [];
    return Array.isArray(x) ? x : [x];
}

function getEntryName(entry) {
    return entry?.["@_name"] || entry?.["@name"] || entry?.name || null;
}

function normalizeMode(raw) {
    const m = String(raw || "overlap").trim().toLowerCase();
    if (m === "overlap" || m === "contained" || m === "exact") return m;
    return "overlap";
}

/**
 * Resolve an object/group member into concrete address strings.
 * Handles:
 *  - literal IP/CIDR/range
 *  - address object names (scope or shared)
 *  - address-group names (nested)
 */
function resolveMember(scopeKey, member, maps, depth = 0, seen = new Set()) {
    if (depth > 25) return [];
    if (!member || typeof member !== "string") return [];

    const m = member.trim();
    if (!m || m.toLowerCase() === "any") return [];

    const loopKey = `${scopeKey}::${m}`;
    if (seen.has(loopKey)) return [];
    seen.add(loopKey);

    // Literal-ish
    if (parseValue(m)) return [m];

    const addrMap = maps.addr.get(scopeKey);
    const sharedAddr = maps.addr.get("shared");
    const grpMap = maps.grp.get(scopeKey);
    const sharedGrp = maps.grp.get("shared");

    // Address object lookup
    const addrVal = (addrMap && addrMap.get(m)) || (sharedAddr && sharedAddr.get(m));
    if (addrVal) return [String(addrVal).trim()];

    // Group lookup (scope group, or shared group)
    const members = (grpMap && grpMap.get(m)) || (sharedGrp && sharedGrp.get(m));
    if (!members) return [];

    const out = [];
    for (const child of members) {
        out.push(...resolveMember(scopeKey, String(child), maps, depth + 1, seen));
    }
    return out;
}

/**
 * Check one rule for matches.
 * Adds match_via for debugging:
 *  - "literal"        : member was a literal ip/cidr/range in the rule
 *  - "address-object" : member was an address object name that resolved to a value
 *  - "address-group"  : member was a group name that resolved (possibly nested) to values
 */
function checkRuleForMatches({
    scopeKey,
    scopeLabel,
    rulebaseLabel,
    ruleEntry,
    maps,
    targetStr,
    mode,
    results,
}) {
    const ruleName = getEntryName(ruleEntry) || "unnamed-rule";

    const srcMembers = asArray(ruleEntry?.source?.member).map(String);
    const dstMembers = asArray(ruleEntry?.destination?.member).map(String);

    function checkSide(sideName, members) {
        for (const mem of members) {
            const m = String(mem || "").trim();
            if (!m || m.toLowerCase() === "any") continue;

            // 1) Literal (ip/cidr/range) in rule
            if (parseValue(m) && ipMatches(m, targetStr, mode)) {
                results.push({
                    device_group: scopeLabel,
                    rulebase: rulebaseLabel,
                    rule: ruleName,
                    matched_on: sideName,
                    object: m,
                    resolved_value: m,
                    match_via: "literal",
                });
                continue;
            }

            // 2) Address OBJECT name (scope/shared) -> resolve once
            const addrMap = maps.addr.get(scopeKey);
            const sharedAddr = maps.addr.get("shared");
            const addrVal = (addrMap && addrMap.get(m)) || (sharedAddr && sharedAddr.get(m));

            if (addrVal) {
                const val = String(addrVal).trim();
                if (ipMatches(val, targetStr, mode)) {
                    results.push({
                        device_group: scopeLabel,
                        rulebase: rulebaseLabel,
                        rule: ruleName,
                        matched_on: sideName,
                        object: m,
                        resolved_value: val,          // IMPORTANT: show actual value, not a message
                        match_via: "address-object",
                    });
                }
                continue;
            }

            // 3) Group (or unknown) -> resolve recursively
            const resolved = resolveMember(scopeKey, m, maps);
            const candidates = resolved.length ? resolved : [];

            for (const val of candidates) {
                if (ipMatches(val, targetStr, mode)) {
                    results.push({
                        device_group: scopeLabel,
                        rulebase: rulebaseLabel,
                        rule: ruleName,
                        matched_on: sideName,
                        object: m,
                        resolved_value: val,
                        match_via: "address-group",
                    });
                }
            }
        }
    }

    checkSide("source", srcMembers);
    checkSide("destination", dstMembers);
}

function findMatchingRules(root, targetStr, mode) {
    const maps = buildObjectMaps(root);
    const results = [];

    const config = root?.config || root;

    // ---- Top-level shared rulebases (Panorama shared) ----
    const topShared = config?.shared;
    if (topShared) {
        for (const r of asArray(topShared?.rulebase?.security?.rules?.entry)) {
            checkRuleForMatches({
                scopeKey: "shared",
                scopeLabel: "shared",
                rulebaseLabel: "rulebase",
                ruleEntry: r,
                maps,
                targetStr,
                mode,
                results,
            });
        }

        for (const r of asArray(topShared?.["pre-rulebase"]?.security?.rules?.entry)) {
            checkRuleForMatches({
                scopeKey: "shared",
                scopeLabel: "shared",
                rulebaseLabel: "pre-rulebase",
                ruleEntry: r,
                maps,
                targetStr,
                mode,
                results,
            });
        }

        for (const r of asArray(topShared?.["post-rulebase"]?.security?.rules?.entry)) {
            checkRuleForMatches({
                scopeKey: "shared",
                scopeLabel: "shared",
                rulebaseLabel: "post-rulebase",
                ruleEntry: r,
                maps,
                targetStr,
                mode,
                results,
            });
        }
    }

    // ---- Devices (some exports put shared + DGs under mgt-config/devices) ----
    const devices = [
        ...asArray(config?.devices?.entry),
        ...asArray(config?.["mgt-config"]?.devices?.entry),
    ];

    for (const dev of devices) {
        // Shared rulebases under device (seen in some exports)
        const shared = dev?.shared;
        if (shared) {
            for (const r of asArray(shared?.rulebase?.security?.rules?.entry)) {
                checkRuleForMatches({
                    scopeKey: "shared",
                    scopeLabel: "shared",
                    rulebaseLabel: "rulebase",
                    ruleEntry: r,
                    maps,
                    targetStr,
                    mode,
                    results,
                });
            }

            for (const r of asArray(shared?.["pre-rulebase"]?.security?.rules?.entry)) {
                checkRuleForMatches({
                    scopeKey: "shared",
                    scopeLabel: "shared",
                    rulebaseLabel: "pre-rulebase",
                    ruleEntry: r,
                    maps,
                    targetStr,
                    mode,
                    results,
                });
            }

            for (const r of asArray(shared?.["post-rulebase"]?.security?.rules?.entry)) {
                checkRuleForMatches({
                    scopeKey: "shared",
                    scopeLabel: "shared",
                    rulebaseLabel: "post-rulebase",
                    ruleEntry: r,
                    maps,
                    targetStr,
                    mode,
                    results,
                });
            }
        }

        // Device-group rulebases
        for (const dg of asArray(dev?.["device-group"]?.entry)) {
            const dgName = getEntryName(dg) || "unknown-dg";
            const scopeKey = `dg:${dgName}`;
            const scopeLabel = `device-group:${dgName}`;

            for (const r of asArray(dg?.rulebase?.security?.rules?.entry)) {
                checkRuleForMatches({
                    scopeKey,
                    scopeLabel,
                    rulebaseLabel: "rulebase",
                    ruleEntry: r,
                    maps,
                    targetStr,
                    mode,
                    results,
                });
            }

            for (const r of asArray(dg?.["pre-rulebase"]?.security?.rules?.entry)) {
                checkRuleForMatches({
                    scopeKey,
                    scopeLabel,
                    rulebaseLabel: "pre-rulebase",
                    ruleEntry: r,
                    maps,
                    targetStr,
                    mode,
                    results,
                });
            }

            for (const r of asArray(dg?.["post-rulebase"]?.security?.rules?.entry)) {
                checkRuleForMatches({
                    scopeKey,
                    scopeLabel,
                    rulebaseLabel: "post-rulebase",
                    ruleEntry: r,
                    maps,
                    targetStr,
                    mode,
                    results,
                });
            }
        }
    }

    return results;
}

/**
 * GET /api/search?ip=4.2.2.2&mode=overlap
 * Also accepts: q=, target=
 */
router.get("/search", (req, res) => {
    try {
        const raw =
            String(req.query.ip || "").trim() ||
            String(req.query.q || "").trim() ||
            String(req.query.target || "").trim();

        if (!raw) {
            return res.status(400).json({ error: "Missing ip query param (or q/target)" });
        }

        const mode = normalizeMode(req.query.mode);

        const root = loadAndParseConfig();
        const matches = findMatchingRules(root, raw, mode);

        res.json({
            ip: raw,
            mode,
            count: matches.length,
            matches,
        });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

module.exports = router;