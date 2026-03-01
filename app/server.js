// app/server.js
const express = require("express");
const path = require("path");
const { getConfigFile } = require("./lib/config");

const app = express();
const PORT = process.env.PORT || 5050;

const searchRoutes = require("./routes/search");
const diagRoutes = require("./routes/diag");
const uploadRoutes = require("./routes/upload");

// Serve uploaded files folder (not strictly required, but useful for debugging)
app.use("/uploads", express.static(path.join(__dirname, "..", "uploads")));

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
        input[type="text"] {
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

        /* --- Upload strip --- */
        .uploadStrip {
            display: flex;
            gap: 10px;
            align-items: center;
            flex-wrap: wrap;
            margin-bottom: 12px;
        }
        input[type="file"] {
            border: 1px solid #ccc;
            border-radius: 10px;
            padding: 8px;
            background: #fff;
        }
        .pill {
            display: inline-block;
            padding: 4px 10px;
            border: 1px solid #ddd;
            border-radius: 999px;
            background: #fafafa;
            font-size: 12px;
            color: #444;
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
    <p class="muted">Active config: <code id="activeConfig">${getConfigFile()}</code></p>

    <div class="card">
        <div class="uploadStrip">
            <input id="cfgFile" type="file" accept=".xml,text/xml,application/xml" />
            <button id="uploadBtn">Upload Config</button>
            <span class="pill" id="uploadStatus">No upload</span>
        </div>

        <div class="row">
            <input id="ip" type="text" placeholder="10.1.2.3  or  10.1.2.0/24" />
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
    <div id="progressText">Working…</div>

<script>
    const btn = document.getElementById("btn");
    const ipInput = document.getElementById("ip");
    const statusEl = document.getElementById("status");
    const errorEl = document.getElementById("error");
    const resultsEl = document.getElementById("results");

    const cfgFileEl = document.getElementById("cfgFile");
    const uploadBtn = document.getElementById("uploadBtn");
    const uploadStatus = document.getElementById("uploadStatus");
    const activeConfigEl = document.getElementById("activeConfig");

    const progressWrap = document.getElementById("progressWrap");
    const progressBar = document.getElementById("progressBar");
    const progressText = document.getElementById("progressText");

    // Export button (created dynamically)
    const exportBtn = document.createElement("button");
    exportBtn.id = "exportCsv";
    exportBtn.textContent = "Export CSV";
    exportBtn.disabled = true;
    btn.parentNode.insertBefore(exportBtn, btn.nextSibling);

    let lastSearchResponse = null;

    function esc(s) {
        return String(s).replace(/[&<>"']/g, c => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[c]));
    }

    function selectedMode() {
        const el = document.querySelector('input[name="mode"]:checked');
        return el ? el.value : "overlap";
    }

    // ----- Progress helpers -----
    function showProgress(label) {
        progressWrap.style.display = "block";
        progressText.style.display = "block";
        progressText.textContent = label || "Working…";
        setProgress(0);
    }

    function setProgress(pct) {
        const p = Math.max(0, Math.min(100, Number(pct) || 0));
        progressBar.style.width = p.toFixed(1) + "%";
    }

    function hideProgress() {
        progressWrap.style.display = "none";
        progressText.style.display = "none";
        setProgress(0);
    }

    // “Analysis” progress: not real %, but gives feedback while request runs
    function startAnalysisProgress() {
        showProgress("Analyzing…");
        let p = 10;
        setProgress(p);

        const t = setInterval(() => {
            // creep toward 90%
            p = Math.min(90, p + Math.random() * 6);
            setProgress(p);
        }, 160);

        return () => {
            clearInterval(t);
            setProgress(100);
            setTimeout(hideProgress, 250);
        };
    }

    // ----- CSV Export -----
    function csvEscape(v) {
        const s = String(v ?? "");
        if (/[",\\n\\r]/.test(s)) {
            return '"' + s.replace(/"/g, '""') + '"';
        }
        return s;
    }

    function toCsv(rows) {
        const headers = [
            "device_group",
            "rulebase",
            "rule",
            "matched_on",
            "object",
            "resolved_value",
            "match_via"
        ];

        const lines = [];
        lines.push(headers.join(","));

        for (const r of rows) {
            lines.push([
                csvEscape(r.device_group),
                csvEscape(r.rulebase),
                csvEscape(r.rule),
                csvEscape(r.matched_on),
                csvEscape(r.object),
                csvEscape(r.resolved_value),
                csvEscape(r.match_via)
            ].join(","));
        }

        return lines.join("\\n");
    }

    function downloadCsv(csvText, filename) {
        const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);

        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);

        URL.revokeObjectURL(url);
    }

    exportBtn.onclick = () => {
        if (!lastSearchResponse || !Array.isArray(lastSearchResponse.matches) || lastSearchResponse.matches.length === 0) {
            return;
        }

        const csv = toCsv(lastSearchResponse.matches);

        const safeIp = String(lastSearchResponse.ip || "query")
            .replace(/[^a-zA-Z0-9._-]+/g, "_")
            .slice(0, 80);

        const safeMode = String(lastSearchResponse.mode || "mode")
            .replace(/[^a-zA-Z0-9._-]+/g, "_")
            .slice(0, 30);

        const filename = "panorama-ip-finder_" + safeIp + "_" + safeMode + ".csv";
        downloadCsv(csv, filename);
    };

    // ----- Upload with REAL progress -----
    uploadBtn.onclick = () => {
        errorEl.textContent = "";
        statusEl.textContent = "";
        resultsEl.innerHTML = "";

        const f = cfgFileEl.files && cfgFileEl.files[0];
        if (!f) {
            errorEl.textContent = "Pick an XML file first.";
            return;
        }

        const form = new FormData();
        form.append("config", f);

        uploadBtn.disabled = true;
        uploadStatus.textContent = "Uploading…";

        showProgress("Uploading config…");
        setProgress(0);

        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/upload", true);

        xhr.upload.onprogress = (evt) => {
            if (!evt.lengthComputable) return;
            const pct = (evt.loaded / evt.total) * 100;
            setProgress(pct);
            progressText.textContent = "Uploading… " + pct.toFixed(0) + "%";
        };

        xhr.onload = () => {
            try {
                const isJson = (xhr.getResponseHeader("content-type") || "").includes("application/json");
                const data = isJson ? JSON.parse(xhr.responseText) : null;

                if (xhr.status >= 200 && xhr.status < 300) {
                    uploadStatus.textContent = "Active: " + (data && data.original_name ? data.original_name : "uploaded");
                    activeConfigEl.textContent = data && data.config_file ? data.config_file : activeConfigEl.textContent;
                    progressText.textContent = "Upload complete";
                    setProgress(100);
                    setTimeout(hideProgress, 250);
                } else {
                    const msg = (data && data.error) ? data.error : ("Upload failed (" + xhr.status + ")");
                    errorEl.textContent = msg;
                    uploadStatus.textContent = "Upload failed";
                    hideProgress();
                }
            } catch (e) {
                errorEl.textContent = "Upload response parse error: " + (e.message || String(e));
                uploadStatus.textContent = "Upload failed";
                hideProgress();
            } finally {
                uploadBtn.disabled = false;
            }
        };

        xhr.onerror = () => {
            errorEl.textContent = "Upload failed (network error).";
            uploadStatus.textContent = "Upload failed";
            uploadBtn.disabled = false;
            hideProgress();
        };

        xhr.send(form);
    };

    // ----- Search with analysis progress -----
    btn.onclick = async () => {
        errorEl.textContent = "";
        resultsEl.innerHTML = "";
        statusEl.textContent = "";

        exportBtn.disabled = true;
        lastSearchResponse = null;

        const ip = ipInput.value.trim();
        if (!ip) {
            errorEl.textContent = "Enter an IP or CIDR.";
            return;
        }

        const mode = selectedMode();

        btn.disabled = true;
        statusEl.textContent = "Searching…";

        const stopProgress = startAnalysisProgress();

        try {
            const r = await fetch("/api/search?ip=" + encodeURIComponent(ip) + "&mode=" + encodeURIComponent(mode));
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || "Search failed");

            lastSearchResponse = data;
            exportBtn.disabled = !(data.matches && data.matches.length);

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
                    <td><code>\${esc(m.match_via || "")}</code></td>
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
                            <th>Match Via</th>
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
app.use("/api", uploadRoutes);
app.use("/api", diagRoutes);
app.use("/api", searchRoutes);

// Start server
app.listen(PORT, () => {
    console.log(`Panorama IP Finder listening on http://0.0.0.0:${PORT}`);
    console.log(`Using config: ${getConfigFile()}`);
});