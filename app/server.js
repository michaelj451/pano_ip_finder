const express = require("express");
const { CONFIG_FILE } = require("./lib/config");

const app = express();
const PORT = process.env.PORT || 5050;

const diagRoutes = require("./routes/diag");
const searchRoutes = require("./routes/search");

// Homepage (UI)
app.get("/", (req, res) => {
    res.type("html").send(`<!doctype html>
<html>
<head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width,initial-scale=1"/>
    <title>Panorama IP Finder</title>
    <style>
        body {
            font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
            margin: 24px;
        }
        .card {
            border: 1px solid #ddd;
            border-radius: 10px;
            padding: 16px;
            max-width: 1100px;
        }
        input {
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 8px;
            width: 340px;
        }
        button {
            padding: 10px 14px;
            border: 1px solid #333;
            border-radius: 10px;
            background: #fff;
            cursor: pointer;
            font-weight: 600;
        }
        button:disabled {
            opacity: 0.6;
            cursor: not-allowed;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin-top: 12px;
        }
        th, td {
            border-top: 1px solid #eee;
            padding: 8px;
            text-align: left;
            vertical-align: top;
        }
        th {
            background: #fafafa;
            position: sticky;
            top: 0;
        }
        code {
            background: #f6f6f6;
            padding: 2px 6px;
            border-radius: 6px;
        }
        .muted {
            color: #555;
        }
        .err {
            color: #b00020;
            font-weight: 700;
        }
        .row {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
        }
        .radio {
            display: flex;
            gap: 14px;
            align-items: center;
        }
        label {
            user-select: none;
        }

        /* --- Progress bar (bottom) --- */
        #progressWrap {
            position: fixed;
            left: 0;
            right: 0;
            bottom: 0;
            height: 10px;
            background: rgba(0, 0, 0, 0.08);
            display: none;
            z-index: 9999;
        }
        #progressBar {
            height: 100%;
            width: 0%;
            background: rgba(0, 0, 0, 0.65);
            transition: width 120ms linear;
        }
        #progressText {
            position: fixed;
            left: 12px;
            bottom: 14px;
            font-size: 12px;
            color: #444;
            background: rgba(255,255,255,0.9);
            padding: 4px 8px;
            border: 1px solid #e5e5e5;
            border-radius: 8px;
            display: none;
            z-index: 10000;
        }
    </style>
</head>
<body>
    <h2>Panorama IP Finder</h2>
    <p class="muted">Config file: <code>${CONFIG_FILE}</code></p>

    <div class="card">
        <div class="row">
            <input id="ip" placeholder="10.1.2.3  or  10.1.2.0/24" />
            <button id="btn">Search</button>

            <div class="radio">
                <label>
                    <input type="radio" name="mode" value="contained" />
                    match (contained)
                </label>
                <label>
                    <input type="radio" name="mode" value="exact" />
                    exact
                </label>
                <label>
                    <input type="radio" name="mode" value="overlap" checked />
                    overlap
                </label>
            </div>

            <span id="status" class="muted"></span>
        </div>

        <div id="error" class="err" style="margin-top:10px;"></div>
        <div id="results"></div>
    </div>

    <!-- Progress UI -->
    <div id="progressWrap"><div id="progressBar"></div></div>
    <div id="progressText">Loading config…</div>

<script>
    const btn = document.getElementById("btn");
    const ipInput = document.getElementById("ip");
    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");
    const resultsEl = document.getElementById("results");

    const progressWrap = document.getElementById("progressWrap");
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");

    let progressTimer = null;
    let progressPct = 0;

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
        }[c]));
    }

    function selectedMode() {
        const el = document.querySelector('input[name="mode"]:checked');
        return el ? el.value : "overlap";
    }

    function startProgress(label) {
        if (progressTimer) clearInterval(progressTimer);

        progressPct = 5;
        progressBar.style.width = progressPct + "%";
        progressWrap.style.display = "block";
        progressText.textContent = label || "Loading config…";
        progressText.style.display = "block";

        // Indeterminate-ish: move toward 90% while request runs
        progressTimer = setInterval(() => {
            const bump = Math.random() * 6;          // 0..6
            progressPct = Math.min(90, progressPct + bump);
            progressBar.style.width = progressPct + "%";
        }, 140);
    }

    function stopProgress() {
        if (progressTimer) {
            clearInterval(progressTimer);
            progressTimer = null;
        }

        // Snap to 100, then hide
        progressBar.style.width = "100%";
        setTimeout(() => {
            progressWrap.style.display = "none";
            progressText.style.display = "none";
            progressBar.style.width = "0%";
        }, 250);
    }

    btn.onclick = async () => {
        errorEl.textContent = "";
        resultsEl.innerHTML = "";

        const ip = ipInput.value.trim();
        if (!ip) {
            errorEl.textContent = "Enter an IP or CIDR.";
            return;
        }

        const mode = selectedMode();

        btn.disabled = true;
        statusEl.textContent = "Searching...";
        startProgress("Loading config…");

        try {
            const r = await fetch("/api/search?ip=" + encodeURIComponent(ip) + "&mode=" + encodeURIComponent(mode));
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || "Search failed");

            statusEl.textContent = "Matches: " + data.count + " (" + data.mode + ")";

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
            stopProgress();
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
    console.log(`Panorama IP Finder server running on port ${PORT}`);
    console.log(`Using config file: ${CONFIG_FILE}`)
});