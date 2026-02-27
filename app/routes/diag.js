// app/routes/diag.js
const express = require("express");
const { loadAndParseConfig, CONFIG_FILE } = require("../lib/config");
const { buildObjectMaps, countDiscoveredRules } = require("../lib/parse");

const router = express.Router();

router.get("/diag", (req, res) => {
    try {
        const needle = String(req.query.needle || "").trim();
        if (!needle) return res.status(400).json({ error: "Missing needle query param" });

        const root = loadAndParseConfig();
        const maps = buildObjectMaps(root);
        const ruleCounts = countDiscoveredRules(root);

        const sharedAddr = maps.addr.get("shared");
        const sharedVal = sharedAddr ? sharedAddr.get(needle) : undefined;

        res.json({
            config_file: CONFIG_FILE,
            needle,
            shared_object_value_if_name: sharedVal || null,
            shared_addr_count: sharedAddr ? sharedAddr.size : 0,
            rule_counts: ruleCounts,
        });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

module.exports = router;   // ✅ THIS LINE matters