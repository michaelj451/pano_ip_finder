const express = require("express");
const { loadAndParseConfig } = require("../lib/config");
const { buildObjectMaps, resolveMember, asArray, getEntryName, nodeText } = require("../lib/parse");
const { normalizeTarget, ipMatchesTarget } = require("../lib/ipmatch");

const router = express.Router();

function findMatchingRules(root, targetIp) {
    const target = normalizeTarget(targetIp);
    const maps = buildObjectMaps(root);
    const results = [];

    const config = root?.config || root;

    function extractMembers(maybeMembers) {
        return asArray(maybeMembers).map(nodeText).filter(Boolean);
    }

    function checkRule(scopeKey, scopeLabel, rulebaseLabel, ruleEntry) {
        const ruleName = getEntryName(ruleEntry) || "unnamed-rule";
        const srcMembers = extractMembers(ruleEntry?.source?.member);
        const dstMembers = extractMembers(ruleEntry?.destination?.member);

        const checkSide = (sideName, members) => {
            for (const mem of members) {
                const resolved = resolveMember(scopeKey, mem, maps);
                const candidates = resolved.length ? resolved : [mem];

                for (const val of candidates) {
                    if (ipMatchesTarget(val, target)) {
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
        };

        checkSide("source", srcMembers);
        checkSide("destination", dstMembers);
    }

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

    const devices = [
        ...asArray(config?.devices?.entry),
        ...asArray(config?.["mgt-config"]?.devices?.entry),
    ];

    for (const dev of devices) {
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

router.get("/search", (req, res) => {
    try {
        const ip = String(req.query.ip || "").trim();
        if (!ip) return res.status(400).json({ error: "Missing ip query param" });

        const root = loadAndParseConfig();
        const matches = findMatchingRules(root, ip);

        res.json({ ip, count: matches.length, matches });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

module.exports = router;