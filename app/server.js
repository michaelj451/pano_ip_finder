const fs = require("fs");
const path = require("path");
const express = require("express");
const { XMLParser } = require("fast-xml-parser");
const ipaddr = require("ipaddr.js");

const app = express();

const CONFIG_FILE = process.env.PANO_CONFIG || path.join(__dirname, "..", "pano_config-1.xml");
const PORT = process.env.PORT || 5050;

// ------------ XML parsing cache ------------
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
    return cache.parsedRoot; // cached
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

// ------------ Helpers ------------
function asArray(x) {
  if (x === undefined || x === null) return [];
  return Array.isArray(x) ? x : [x];
}

function getEntryName(entry) {
  return entry?.["@_name"] || entry?.["@name"] || entry?.name || null;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "string") throw new Error("Missing IP");
  const t = target.trim();

  if (t.includes("/")) {
    const [ip, pref] = t.split("/");
    if (!ipaddr.isValid(ip)) throw new Error(`Invalid CIDR IP: ${ip}`);
    const prefix = Number(pref);
    if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) throw new Error(`Invalid CIDR prefix: ${pref}`);
    return { kind: "cidr", ip: ipaddr.parse(ip), prefix };
  }

  if (!ipaddr.isValid(t)) throw new Error(`Invalid IP: ${t}`);
  return { kind: "ip", ip: ipaddr.parse(t) };
}

function toInt(ip) {
  // IPv4 only (Panorama configs here assumed IPv4; add v6 if you need it)
  return ip.toByteArray().reduce((acc, n) => (acc * 256) + n, 0);
}

function ipMatchesTarget(value, target) {
  if (!value || typeof value !== "string") return false;
  const v = value.trim();
  if (!v || v === "any") return false;

  // IP range: A-B
  if (v.includes("-")) {
    const [a, b] = v.split("-").map(s => s.trim());
    if (!ipaddr.isValid(a) || !ipaddr.isValid(b)) return false;
    const A = ipaddr.parse(a);
    const B = ipaddr.parse(b);

    const aInt = toInt(A);
    const bInt = toInt(B);

    if (target.kind === "ip") {
      const tInt = toInt(target.ip);
      return aInt <= tInt && tInt <= bInt;
    } else {
      // CIDR overlap with range (approx via bounds of CIDR)
      const prefix = target.prefix;
      const mask = prefix === 0 ? 0 : (~((1 << (32 - prefix)) - 1)) >>> 0;
      const net = (toInt(target.ip) & mask) >>> 0;
      const broadcast = (net + ((1 << (32 - prefix)) - 1)) >>> 0;
      return !(bInt < net || aInt > broadcast);
    }
  }

  // CIDR value
  if (v.includes("/")) {
    const [ip, pref] = v.split("/");
    if (!ipaddr.isValid(ip)) return false;
    const net = ipaddr.parse(ip);
    const prefix = Number(pref);
    if (!Number.isFinite(prefix)) return false;

    if (target.kind === "ip") return target.ip.match(net, prefix);

    // network overlap: either contains the other
    const aContainsB = (aIp, aPref, bIp, bPref) => bIp.match(aIp, aPref) && aPref <= bPref;
    return aContainsB(target.ip, target.prefix, net, prefix) || aContainsB(net, prefix, target.ip, target.prefix);
  }

  // Single IP value
  if (ipaddr.isValid(v)) {
    const ip = ipaddr.parse(v);
    if (target.kind === "ip") return ip.toString() === target.ip.toString();
    return ip.match(target.ip, target.prefix);
  }

  // fqdn / unknown string
  return false;
}

/**
 * Build maps:
 *   addr[scope][name] = ip-netmask|ip-range|fqdn
 *   grp[scope][name] = [members...]
 */

function buildObjectMaps(root) {
  const maps = { addr: new Map(), grp: new Map() };

  function ensure(scope) {
    if (!maps.addr.has(scope)) maps.addr.set(scope, new Map());
    if (!maps.grp.has(scope)) maps.grp.set(scope, new Map());
  }

  function addAddr(scope, name, value) {
    if (!name || !value) return;
    ensure(scope);
    maps.addr.get(scope).set(name, String(value).trim());
  }

  function addGrp(scope, name, members) {
    if (!name) return;
    ensure(scope);
    maps.grp.get(scope).set(name, members || []);
  }

  const config = root?.config || root;

  // ✅ Panorama exports often place devices under mgt-config
  const devices = [
    ...asArray(config?.devices?.entry),
    ...asArray(config?.["mgt-config"]?.devices?.entry),
  ];

  for (const dev of devices) {
    // Shared objects
    const shared = dev?.shared;
    if (shared) {
      const scope = "shared";
      ensure(scope);

      for (const a of asArray(shared?.address?.entry)) {
        const name = getEntryName(a);
        const value = a?.["ip-netmask"] || a?.["ip-range"] || a?.fqdn;
        if (value) addAddr(scope, name, value);
      }

      for (const g of asArray(shared?.["address-group"]?.entry)) {
        const name = getEntryName(g);
        const members = asArray(g?.static?.member).map(String);
        addGrp(scope, name, members);
      }
    }

    // Device-group objects
    for (const dg of asArray(dev?.["device-group"]?.entry)) {
      const dgName = getEntryName(dg) || "unknown-dg";
      const scope = `dg:${dgName}`;
      ensure(scope);

      for (const a of asArray(dg?.address?.entry)) {
        const name = getEntryName(a);
        const value = a?.["ip-netmask"] || a?.["ip-range"] || a?.fqdn;
        if (value) addAddr(scope, name, value);
      }

      for (const g of asArray(dg?.["address-group"]?.entry)) {
        const name = getEntryName(g);
        const members = asArray(g?.static?.member).map(String);
        addGrp(scope, name, members);
      }
    }
  }

  return maps;
}

function resolveMember(scope, member, maps, depth = 0, seen = new Set()) {
  // resolves objects / nested groups into concrete address strings
  if (depth > 25) return [];
  const key = `${scope}::${member}`;
  if (seen.has(key)) return [];
  seen.add(key);

  if (!member || typeof member !== "string") return [];
  const m = member.trim();
  if (!m || m === "any") return [];

  // literal-ish
  if (ipaddr.isValid(m) || m.includes("/") || m.includes("-")) return [m];

  const addrMap = maps.addr.get(scope);
  const sharedAddr = maps.addr.get("shared");
  const grpMap = maps.grp.get(scope);
  const sharedGrp = maps.grp.get("shared");

  const val = (addrMap && addrMap.get(m)) || (sharedAddr && sharedAddr.get(m));
  if (val) return [val];

  const members = (grpMap && grpMap.get(m)) || (sharedGrp && sharedGrp.get(m));
  if (!members) return [];

  const out = [];
  for (const child of members) {
    out.push(...resolveMember(scope, String(child), maps, depth + 1, seen));
  }
  return out;
}

function findMatchingRules(root, targetIp) {
  const target = normalizeTarget(targetIp);
  const maps = buildObjectMaps(root);
  const results = [];

  const config = root?.config || root;

  // ✅ Pull devices from either location
  const devices = [
    ...asArray(config?.devices?.entry),
    ...asArray(config?.["mgt-config"]?.devices?.entry),
  ];

  function checkRule(scopeKey, scopeLabel, rulebaseLabel, ruleEntry) {
    const ruleName = getEntryName(ruleEntry) || "unnamed-rule";
    const srcMembers = asArray(ruleEntry?.source?.member).map(String);
    const dstMembers = asArray(ruleEntry?.destination?.member).map(String);

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

  for (const dev of devices) {
    // shared rules
    const shared = dev?.shared;
    if (shared) {
      for (const r of asArray(shared?.["pre-rulebase"]?.security?.rules?.entry)) {
        checkRule("shared", "shared", "pre-rulebase", r);
      }
      for (const r of asArray(shared?.["post-rulebase"]?.security?.rules?.entry)) {
        checkRule("shared", "shared", "post-rulebase", r);
      }
    }

    // device-group rules
    for (const dg of asArray(dev?.["device-group"]?.entry)) {
      const dgName = getEntryName(dg) || "unknown-dg";
      const scopeKey = `dg:${dgName}`;

      for (const r of asArray(dg?.["pre-rulebase"]?.security?.rules?.entry)) {
        checkRule(scopeKey, `device-group:${dgName}`, "pre-rulebase", r);
      }
      for (const r of asArray(dg?.["post-rulebase"]?.security?.rules?.entry)) {
        checkRule(scopeKey, `device-group:${dgName}`, "post-rulebase", r);
      }
    }
  }

  return results;
}



// ------------ Browser UI ------------
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
      <input id="ip" placeholder="10.1.2.3  or  10.1.2.0/24" />
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

// ------------ API ------------
app.get("/api/search", (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Panorama IP Finder listening on http://0.0.0.0:${PORT}`);
  console.log(`Using config: ${CONFIG_FILE}`);
});