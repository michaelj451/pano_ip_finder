const ipaddr = require("ipaddr.js");

function asArray(x) {
    if (x === undefined || x === null) return [];
    return Array.isArray(x) ? x : [x];
}

function getEntryName(entry) {
    return entry?.["@_name"] || entry?.["@name"] || entry?.name || null;
}

function nodeText(x) {
    if (x === undefined || x === null) return null;
    if (typeof x === "string" || typeof x === "number" || typeof x === "boolean") {
        return String(x).trim();
    }
    if (typeof x === "object") {
        const v =
            x["#text"] ??
            x["text"] ??
            x["$text"] ??
            x["@_text"] ??
            x["@text"] ??
            null;
        if (v !== null && v !== undefined) return String(v).trim();
    }
    return null;
}

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

    const topShared = config?.shared;
    if (topShared) {
        const scope = "shared";
        ensure(scope);

        for (const a of asArray(topShared?.address?.entry)) {
            const name = getEntryName(a);
            const value = a?.["ip-netmask"] || a?.["ip-range"] || a?.fqdn;
            if (value) addAddr(scope, name, value);
        }

        for (const g of asArray(topShared?.["address-group"]?.entry)) {
            const name = getEntryName(g);
            const members = asArray(g?.static?.member).map(nodeText).filter(Boolean);
            addGrp(scope, name, members);
        }
    }

    const devices = [
        ...asArray(config?.devices?.entry),
        ...asArray(config?.["mgt-config"]?.devices?.entry),
    ];

    for (const dev of devices) {
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
                const members = asArray(g?.static?.member).map(nodeText).filter(Boolean);
                addGrp(scope, name, members);
            }
        }

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
                const members = asArray(g?.static?.member).map(nodeText).filter(Boolean);
                addGrp(scope, name, members);
            }
        }
    }

    return maps;
}

function resolveMember(scope, member, maps, depth = 0, seen = new Set()) {
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

function countDiscoveredRules(root) {
    const config = root?.config || root;

    const counts = {
        shared_rulebase: 0,
        shared_pre: 0,
        shared_post: 0,
        dg_rulebase: 0,
        dg_pre: 0,
        dg_post: 0,
        dg_scopes: 0,
    };

    const topShared = config?.shared;
    if (topShared) {
        counts.shared_rulebase += asArray(topShared?.rulebase?.security?.rules?.entry).length;
        counts.shared_pre += asArray(topShared?.["pre-rulebase"]?.security?.rules?.entry).length;
        counts.shared_post += asArray(topShared?.["post-rulebase"]?.security?.rules?.entry).length;
    }

    const devices = [
        ...asArray(config?.devices?.entry),
        ...asArray(config?.["mgt-config"]?.devices?.entry),
    ];

    for (const dev of devices) {
        const shared = dev?.shared;
        if (shared) {
            counts.shared_rulebase += asArray(shared?.rulebase?.security?.rules?.entry).length;
            counts.shared_pre += asArray(shared?.["pre-rulebase"]?.security?.rules?.entry).length;
            counts.shared_post += asArray(shared?.["post-rulebase"]?.security?.rules?.entry).length;
        }

        for (const dg of asArray(dev?.["device-group"]?.entry)) {
            counts.dg_scopes += 1;
            counts.dg_rulebase += asArray(dg?.rulebase?.security?.rules?.entry).length;
            counts.dg_pre += asArray(dg?.["pre-rulebase"]?.security?.rules?.entry).length;
            counts.dg_post += asArray(dg?.["post-rulebase"]?.security?.rules?.entry).length;
        }
    }

    return counts;
}

module.exports = {
    asArray,
    getEntryName,
    nodeText,
    buildObjectMaps,
    resolveMember,
    countDiscoveredRules,
};