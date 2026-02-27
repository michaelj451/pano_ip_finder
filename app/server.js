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
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Panorama IP Finder</title>
    <style>
        body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
        .card { border: 1px solid #ddd; border-radius: 10px; padding: 16px; max-width: 1100px; }
        input { padding: 10px; border: 1px solid #ccc; border-radius: 8px; width: 340px; }
        button { padding: 10px 14px; border: 1px solid #333; border-radius: 10px; background: #fff; cursor: pointer; font-weight: 600; }
        button:disabled { opacity: 0.6; cursor: not-allowed; }
        table { border-collapse: collapse; width: 100%; margin-top: 12px; }
        th, td { border-top: 1px solid #eee; padding: 8px; text-align: left; vertical-align: top; }
        th { background: #fafafa; position: sticky; top: 0; }
        code { background: #f6f6f6; padding: 2px 6px; border-radius: 6px; }
        .muted { color: #555; }
        .err { color: #b00020; font-weight: 700; }
    </style>
</head>
<body>
    <h2>Panorama IP Finder</h2>
    <p class="muted">Config file: <code>${CONFIG_FILE}</code></p>

    <div class="card">
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <input id="ip" placeholder="4.2.2.2  or  10.1.2.0/24" />
            <button id="btn">Search</button>
            <span id="status" class="muted"></span>
        </div>
        <div id="error" class="err" style="margin-top:10px;"></div>
        <div id="results"></div>
    </div>

<script>
const btn = document.getElementById("btn");
const ipInput = document.getElementById("ip");
const statusEl = document.getElementById("status");
const errorEl = document.getElementById("error");
const resultsEl = document.getElementById("results");

function esc(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

btn.onclick = async () => {
    errorEl.textContent = "";
    resultsEl.innerHTML = "";
    const ip = ipInput.value.trim();
    if (!ip) { errorEl.textContent = "Enter an IP or CIDR."; return; }

    btn.disabled = true;
    statusEl.textContent = "Searching...";
    try {
        const r = await fetch("/api/search?ip=" + encodeURIComponent(ip));
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || "Search failed");

        statusEl.textContent = "Matches: " + data.count;

        if (data.count === 0) {
            resultsEl.innerHTML = "<p>No matches found.</p>";
            return;
        }

        const rows = data.matches.map(m => \`
            <tr>
                <td>\${esc(m.device_group)}</td>
                <td>\${esc(m.rulebase)}</td>
                <td><b>\${esc(m.rule)}</b></td>
                <td>\${esc(m.matched_on)}</td>
                <td><code>\${esc(m.object)}</code></td>
                <td><code>\${esc(m.resolved_value)}</code></td>
            </tr>
        \`).join("");

        resultsEl.innerHTML = \`
            <table>
                <thead>
                    <tr>
                        <th>Device Group</th>
                        <th>Rulebase</th>
                        <th>Rule</th>
                        <th>Matched On</th>
                        <th>Object/Member</th>
                        <th>Resolved Value</th>
                    </tr>
                </thead>
                <tbody>\${rows}</tbody>
            </table>
        \`;
    } catch (e) {
        errorEl.textContent = e.message || String(e);
        statusEl.textContent = "";
    } finally {
        btn.disabled = false;
    }
};
</script>
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