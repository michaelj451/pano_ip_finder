const ipaddr = require("ipaddr.js");

/**
 * normalizeTarget()
 * Accepts:
 *   - single IPv4: "4.2.2.2"
 *   - CIDR IPv4:   "10.2.3.0/24"
 *
 * Returns:
 *   { kind: "ip", ip }
 *   { kind: "cidr", ip, prefix }
 */
function normalizeTarget(target) {
    if (!target || typeof target !== "string") {
        throw new Error("Missing IP/CIDR");
    }

    const t = target.trim();

    // CIDR
    if (t.includes("/")) {
        const [ipRaw, prefRaw] = t.split("/").map((x) => x.trim());
        if (!ipaddr.isValid(ipRaw)) {
            throw new Error(`Invalid CIDR IP: ${ipRaw}`);
        }

        const prefix = Number(prefRaw);
        if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
            throw new Error(`Invalid CIDR prefix: ${prefRaw}`);
        }

        const ip = ipaddr.parse(ipRaw);
        if (ip.kind() !== "ipv4") {
            throw new Error("Only IPv4 is supported");
        }

        return { kind: "cidr", ip, prefix };
    }

    // single IP
    if (!ipaddr.isValid(t)) {
        throw new Error(`Invalid IP: ${t}`);
    }

    const ip = ipaddr.parse(t);
    if (ip.kind() !== "ipv4") {
        throw new Error("Only IPv4 is supported");
    }

    return { kind: "ip", ip };
}

function toInt(ip) {
    // IPv4 only
    return ip.toByteArray().reduce((acc, n) => (acc * 256) + n, 0) >>> 0;
}

function cidrBounds(ip, prefix) {
    // inclusive [net, broadcast]
    const hostBits = 32 - prefix;
    const mask = prefix === 0 ? 0 : (~((1 << hostBits) - 1)) >>> 0;
    const net = (toInt(ip) & mask) >>> 0;
    const broadcast = (net + ((1 << hostBits) - 1)) >>> 0;
    return { a: net, b: broadcast };
}

/**
 * parseValue()
 * Backwards compatible with your old code.
 *
 * Returns:
 *  - { kind: "ip", ip }
 *  - { kind: "cidr", ip, prefix }
 *  - { kind: "range", a, b }   where a/b are ints (inclusive)
 *  - null
 */
function parseValue(s) {
    if (!s || typeof s !== "string") return null;

    const v = s.trim();
    if (!v || v.toLowerCase() === "any") return null;

    // Range: A-B
    if (v.includes("-")) {
        const [aRaw, bRaw] = v.split("-").map((x) => x.trim());
        if (!ipaddr.isValid(aRaw) || !ipaddr.isValid(bRaw)) return null;

        const aIp = ipaddr.parse(aRaw);
        const bIp = ipaddr.parse(bRaw);
        if (aIp.kind() !== "ipv4" || bIp.kind() !== "ipv4") return null;

        const a = toInt(aIp);
        const b = toInt(bIp);
        return { kind: "range", a: Math.min(a, b) >>> 0, b: Math.max(a, b) >>> 0 };
    }

    // CIDR: A/B
    if (v.includes("/")) {
        const [ipRaw, prefRaw] = v.split("/").map((x) => x.trim());
        if (!ipaddr.isValid(ipRaw)) return null;

        const ip = ipaddr.parse(ipRaw);
        if (ip.kind() !== "ipv4") return null;

        const prefix = Number(prefRaw);
        if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;

        return { kind: "cidr", ip, prefix };
    }

    // Single IP
    if (ipaddr.isValid(v)) {
        const ip = ipaddr.parse(v);
        if (ip.kind() !== "ipv4") return null;
        return { kind: "ip", ip };
    }

    return null;
}

/**
 * ipMatchesTarget(valueStr, targetObj, mode)
 *
 * mode meanings:
 *   - "overlap"   : value overlaps target at all
 *   - "contained" : value is fully INSIDE the target (target contains value)
 *   - "exact"     : value exactly equals the target (IP==IP or CIDR==CIDR)
 */
function ipMatchesTarget(valueStr, targetObj, mode = "overlap") {
    const valueObj = parseValue(valueStr);
    if (!valueObj) return false;

    const m = (mode === "overlap" || mode === "contained" || mode === "exact")
        ? mode
        : "overlap";

    // Target interval
    let tInterval = null;

    if (targetObj.kind === "ip") {
        const n = toInt(targetObj.ip);
        tInterval = { kind: "ip", a: n, b: n, raw: targetObj.ip.toString() };
    } else if (targetObj.kind === "cidr") {
        const b = cidrBounds(targetObj.ip, targetObj.prefix);
        tInterval = { kind: "cidr", a: b.a, b: b.b, raw: `${targetObj.ip.toString()}/${targetObj.prefix}` };
    } else {
        return false;
    }

    // Value interval + raw comparison data
    let vInterval = null;

    if (valueObj.kind === "ip") {
        const n = toInt(valueObj.ip);
        vInterval = { kind: "ip", a: n, b: n, ip: valueObj.ip };
    } else if (valueObj.kind === "cidr") {
        const b = cidrBounds(valueObj.ip, valueObj.prefix);
        vInterval = { kind: "cidr", a: b.a, b: b.b, ip: valueObj.ip, prefix: valueObj.prefix };
    } else if (valueObj.kind === "range") {
        vInterval = { kind: "range", a: valueObj.a >>> 0, b: valueObj.b >>> 0 };
    } else {
        return false;
    }

    // EXACT: strict equality only (IP==IP or CIDR==CIDR)
    if (m === "exact") {
        if (targetObj.kind === "ip" && vInterval.kind === "ip") {
            return vInterval.ip.toString() === targetObj.ip.toString();
        }

        if (targetObj.kind === "cidr" && vInterval.kind === "cidr") {
            return (
                vInterval.ip.toString() === targetObj.ip.toString() &&
                vInterval.prefix === targetObj.prefix
            );
        }

        return false;
    }

    // CONTAINED: target contains value fully (this is the important direction)
    if (m === "contained") {
        return tInterval.a <= vInterval.a && vInterval.b <= tInterval.b;
    }

    // OVERLAP: any overlap
    return !(vInterval.b < tInterval.a || vInterval.a > tInterval.b);
}

/**
 * ipMatches(valueStr, targetStr, mode)
 * Backwards compatible wrapper for your older route/search logic.
 *
 * NOTE:
 *   - This wrapper uses normalizeTarget(targetStr) for the target
 *   - Then delegates to ipMatchesTarget(valueStr, targetObj, mode)
 */
function ipMatches(valueStr, targetStr, mode = "overlap") {
    const targetObj = normalizeTarget(targetStr);
    return ipMatchesTarget(valueStr, targetObj, mode);
}

module.exports = {
    // New API
    normalizeTarget,
    ipMatchesTarget,

    // Backwards compatible API (so your existing search.js doesn't break)
    parseValue,
    ipMatches,
};