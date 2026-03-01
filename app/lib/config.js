// app/lib/config.js
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");

const DEFAULT_CONFIG_FILE =
    process.env.PANO_CONFIG || path.join(__dirname, "..", "..", "pano_sample.xml.txt");

let activeConfigFile = DEFAULT_CONFIG_FILE;

let cache = {
    file: null,
    mtimeMs: 0,
    parsedRoot: null,
};

function getConfigFile() {
    return activeConfigFile;
}

function setConfigFile(newPath) {
    if (!newPath || typeof newPath !== "string") {
        throw new Error("setConfigFile: newPath must be a string");
    }
    if (!fs.existsSync(newPath)) {
        throw new Error(`Config file not found: ${newPath}`);
    }
    activeConfigFile = newPath;
    // Invalidate cache on file switch
    cache = { file: null, mtimeMs: 0, parsedRoot: null };
}

function loadAndParseConfig() {
    const file = getConfigFile();

    if (!fs.existsSync(file)) {
        throw new Error(`Config file not found: ${file}`);
    }

    const st = fs.statSync(file);
    if (cache.parsedRoot && cache.file === file && cache.mtimeMs === st.mtimeMs) {
        return cache.parsedRoot;
    }

    const xml = fs.readFileSync(file, "utf8");
    const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
    });

    const root = parser.parse(xml);
    cache = { file, mtimeMs: st.mtimeMs, parsedRoot: root };
    return root;
}

module.exports = {
    DEFAULT_CONFIG_FILE,
    getConfigFile,
    setConfigFile,
    loadAndParseConfig,
};