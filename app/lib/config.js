const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const CONFIG_FILE =
    process.env.PANO_CONFIG || path.join(__dirname, "..", "..", "pano_config-1.xml");

let cache = {
    mtimeMs: 0,
    parsedRoot: null,
};

function loadAndParseConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        throw new Error(`Config file not found: ${CONFIG_FILE}`);
    }

    const st = fs.statSync(CONFIG_FILE);
    if (cache.parsedRoot && cache.mtimeMs === st.mtimeMs) {
        return cache.parsedRoot;
    }

    const xml = fs.readFileSync(CONFIG_FILE, "utf8");
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
    });

    const root = parser.parse(xml);
    cache = { mtimeMs: st.mtimeMs, parsedRoot: root };
    return root;
}

module.exports = {
    CONFIG_FILE,
    loadAndParseConfig,
};