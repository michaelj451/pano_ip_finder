const ipaddr = require("ipaddr.js");

/**
 * Parse a string into one of:
 *  - { kind: "ip", ip }
 *  - { kind: "cidr", ip, prefix }
 *  - { kind: "range", a, b }   (inclusive bounds)
 *  - null (not parseable as IP/CIDR/range)
 */
function parseValue(s) {
    if (!s || typeof s !== "string") return null;
    const v = s.trim();
    if (!v || v.toLowerCase() === "any") return null;

    // Range: A-B
    if (v.includes("-")) {
        const [aRaw, bRaw] = v.split("-").map((x) => x.trim());
        if (!ipaddr.isValid(aRaw) || !ipaddr.isValid(bRaw)) return null;
        const a = ipaddr.parse(aRaw);
        const b = ipaddr.parse(bRaw);
        // Only IPv4 supported here
        if (a.kind() !== "ipv4" || b.kind() !== "ipv4") return null;

        const aInt = toInt(a);
        const bInt = toInt(b);
        const lo = Math.min(aInt, bInt);
        const hi = Math.max(aInt, bInt);
        return { kind: "range", a: lo, b: hi };
    }

    // CIDR: A/B
    if (v.includes("/")) {
        const [ipRaw, prefRaw] = v.split("/").map((x) => x.trim());
        if (!ipaddr.isValid(ipRaw)) return null;
        const prefix = Number(prefRaw);
        if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) return null;

        const ip = ipaddr.parse(ipRaw);
        if (ip.kind() !== "ipv4") return null;
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

function toInt(ip) {
    // IPv4 only
    return ip.toByteArray().reduce((acc, n) => (acc * 256) + n, 0) >>> 0;
}

function cidrBounds(cidr) {
    const prefix = cidr.prefix;
    const hostBits = 32 - prefix;

    const mask = prefix === 0 ? 0 : (~((1 << hostBits) - 1)) >>> 0;
    const net = (toInt(cidr.ip) & mask) >>> 0;
    const broadcast = (net + ((1 << hostBits) - 1)) >>> 0;

    return { a: net, b: broadcast };
}

/**
 * Does "value" match "target"?
 *
 * mode:
 *  - "overlap": any overlap between ranges (best for CIDR queries)
 *  - "contained": value must be fully inside target
 *
 * Examples:
 *  target = 10.2.3.0/24
 *   - overlap: 10.2.1.5-10.2.3.5 matches (overlaps)
 *   - contained: 10.2.1.5-10.2.3.5 does NOT match (not fully contained)
 */
function ipMatches(valueStr, targetStr, mode = "overlap") {
    const value = parseValue(valueStr);
    const target = parseValue(targetStr);

    if (!value || !target) return false;

    // Normalize everything to inclusive integer bounds
    const vBounds = boundsOf(value);
    const tBounds = boundsOf(target);

    if (!vBounds || !tBounds) return false;

    if (target.kind === "ip") {
        // For single IP target, treat as "contained by value"
        return vBounds.a <= tBounds.a && tBounds.a <= vBounds.b;
    }

    if (mode === "contained") {
        // value fully inside target
        return tBounds.a <= vBounds.a && vBounds.b <= tBounds.b;
    }

    // default: overlap
    return !(vBounds.b < tBounds.a || vBounds.a > tBounds.b);
}

function boundsOf(obj) {
    if (!obj) return null;

    if (obj.kind === "ip") {
        const n = toInt(obj.ip);
        return { a: n, b: n };
    }

    if (obj.kind === "cidr") {
        return cidrBounds(obj);
    }

    if (obj.kind === "range") {
        return { a: obj.a >>> 0, b: obj.b >>> 0 };
    }

    return null;
}

module.exports = {
    parseValue,
    ipMatches,
};