const ipaddr = require("ipaddr.js");

function normalizeTarget(target) {
    if (!target || typeof target !== "string") {
        throw new Error("Missing IP");
    }

    const t = target.trim();

    if (t.includes("/")) {
        const [ip, pref] = t.split("/");
        if (!ipaddr.isValid(ip)) {
            throw new Error(`Invalid CIDR IP: ${ip}`);
        }

        const prefix = Number(pref);
        if (!Number.isFinite(prefix) || prefix < 0 || prefix > 32) {
            throw new Error(`Invalid CIDR prefix: ${pref}`);
        }

        return { kind: "cidr", ip: ipaddr.parse(ip), prefix };
    }

    if (!ipaddr.isValid(t)) {
        throw new Error(`Invalid IP: ${t}`);
    }

    return { kind: "ip", ip: ipaddr.parse(t) };
}

function toInt(ip) {
    return ip.toByteArray().reduce((acc, n) => (acc * 256) + n, 0);
}

function ipMatchesTarget(value, target) {
    if (!value || typeof value !== "string") return false;

    const v = value.trim();
    if (!v || v === "any") return false;

    // IP range A-B
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

        if (target.kind === "ip") {
            return target.ip.match(net, prefix);
        }

        const aContainsB = (aIp, aPref, bIp, bPref) =>
            bIp.match(aIp, aPref) && aPref <= bPref;

        return (
            aContainsB(target.ip, target.prefix, net, prefix) ||
            aContainsB(net, prefix, target.ip, target.prefix)
        );
    }

    // Single IP
    if (ipaddr.isValid(v)) {
        const ip = ipaddr.parse(v);
        if (target.kind === "ip") {
            return ip.toString() === target.ip.toString();
        }
        return ip.match(target.ip, target.prefix);
    }

    return false;
}

module.exports = {
    normalizeTarget,
    toInt,
    ipMatchesTarget,
};