// app/routes/search.js
// /api/search route
// CommonJS module (require/module.exports), 4-space indents

const express = require("express");
const { loadAndParseConfig } = require("../lib/config");
const { buildObjectMaps } = require("../lib/parse");
const { findMatchingRules } = require("../lib/ipmatch");

const router = express.Router();

router.get("/search", (req, res) => {
    try {
        const ip = String(req.query.ip || "").trim();
        if (!ip) {
            return res.status(400).json({ error: "Missing ip query param" });
        }

        const root = loadAndParseConfig();
        const maps = buildObjectMaps(root);
        const matches = findMatchingRules(root, ip, maps);

        res.json({ ip, count: matches.length, matches });
    } catch (e) {
        res.status(500).json({ error: String(e.message || e) });
    }
});

module.exports = router;