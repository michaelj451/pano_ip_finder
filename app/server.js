const express = require("express");
const { CONFIG_FILE } = require("./lib/config");

const app = express();
const PORT = process.env.PORT || 5050;

/*
    Load a router module safely.
    Handles:
        module.exports = router
        module.exports = { router }
        export default router (ESM transpiled)
*/
function loadRouter(relPath) {
    const mod = require(relPath);

    console.log("--------------------------------------------------");
    console.log(`Loading: ${relPath}`);
    console.log("Resolved to:", require.resolve(relPath));
    console.log("typeof module:", typeof mod);
    if (mod && typeof mod === "object") {
        console.log("module keys:", Object.keys(mod));
    }

    let router = null;

    if (typeof mod === "function") {
        router = mod;
    } else if (mod && typeof mod.router === "function") {
        router = mod.router;
    } else if (mod && typeof mod.default === "function") {
        router = mod.default;
    }

    console.log("typeof router:", typeof router);
    console.log("--------------------------------------------------");

    if (typeof router !== "function") {
        throw new Error(
            `Route at ${relPath} did not export an Express router function`
        );
    }

    return router;
}

// Explicit filenames avoid folder shadowing issues
const diagRoutes = loadRouter("./routes/diag.js");
const searchRoutes = loadRouter("./routes/search.js");

// Simple homepage
app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<html>
<head>
    <meta charset="utf-8"/>
    <title>Panorama IP Finder</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; margin: 24px; }
        code { background: #f4f4f4; padding: 4px 8px; border-radius: 6px; }
    </style>
</head>
<body>
    <h2>Panorama IP Finder</h2>
    <p>Config file:</p>
    <code>${CONFIG_FILE}</code>

    <p>Try:</p>
    <ul>
        <li><code>/api/diag?needle=test-address-4.2.2.2</code></li>
        <li><code>/api/search?ip=4.2.2.2</code></li>
    </ul>
</body>
</html>`);
});

// Mount API routes
app.use("/api", diagRoutes);
app.use("/api", searchRoutes);

// Start server
app.listen(PORT, () => {
    console.log(`Panorama IP Finder listening on http://0.0.0.0:${PORT}`);
    console.log(`Using config: ${CONFIG_FILE}`);
});