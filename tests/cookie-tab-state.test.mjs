import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

// Execute the real component's state/effect handlers with hook doubles, not a mounted React UI.
// Every browser API and network boundary is synthetic; no extension or browser profile is loaded.
const source = readFileSync(new URL("../src/pages/Extension_sidepanel/tabs/cookie.jsx", import.meta.url), "utf8");
const start = source.indexOf("const ShowCookie = () => {");
const end = source.indexOf("\n    return (", start);
assert.ok(start >= 0 && end > start, "component handler boundaries must remain identifiable");
const stateNames = [...source.slice(start, end).matchAll(/const \[(\w+),\s*\w+\] = useState\(/g)].map(match => match[1]);

const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const event = () => {
    const listeners = new Set();
    return {listeners, addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), emit: (...args) => listeners.forEach(fn => fn(...args))};
};

function createHarness({tabs = [{id: 1, url: "https://example.invalid/", title: "Fixture"}], query, getAll, fetch} = {}) {
    const calls = {query: [], getAll: [], fetch: []};
    const onActivated = event(), onUpdated = event(), updateCookie = event();
    const states = [], effects = [];
    let stateIndex = 0, effectIndex = 0, pending = [], scheduled = false, mounted = true;
    const chrome = {
        tabs: {query: async details => { calls.query.push(details); return query ? query() : tabs; }, onActivated, onUpdated},
        cookies: {getAll: async details => { calls.getAll.push(details); return getAll ? getAll(details) : []; }},
    };
    const context = {
        chrome, icons: {chrome: "fixture-default-icon"},
        fetch: async url => { calls.fetch.push(url); return fetch ? fetch(url) : {status: 404}; },
        document: {addEventListener: (name, fn) => { assert.equal(name, "update_cookie"); updateCookie.addListener(fn); }, removeEventListener: (name, fn) => updateCookie.removeListener(fn)},
        useState: initial => {
            const index = stateIndex++;
            if (!(index in states)) states[index] = initial;
            return [states[index], value => {
                if (Object.is(states[index], value)) return;
                states[index] = value;
                if (!scheduled && mounted) {
                    scheduled = true;
                    queueMicrotask(() => { scheduled = false; if (mounted) render(); });
                }
            }];
        },
        useEffect: (fn, deps) => {
            const index = effectIndex++;
            const old = effects[index];
            if (!old || deps.some((dep, i) => !Object.is(dep, old.deps[i]))) {
                effects[index] = {deps};
                pending.push(() => { old?.cleanup?.(); effects[index].cleanup = fn(); });
            }
        },
    };
    const component = vm.runInNewContext(`${source.slice(start, end)}\n}; ShowCookie;`, context, {timeout: 1000});
    function render() {
        stateIndex = 0; effectIndex = 0;
        component();
        const callbacks = pending; pending = [];
        callbacks.forEach(fn => fn());
    }
    render();
    return {
        calls, onActivated, onUpdated, updateCookie,
        get state() { return Object.fromEntries(stateNames.map((name, index) => [name, states[index]])); },
        async flush() { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); },
        unmount() { mounted = false; effects.forEach(effect => effect.cleanup?.()); },
    };
}

for (const [label, tabs] of [["empty list", []], ["undefined tab", [undefined]], ["null tab", [null]], ["missing result", undefined]]) {
    test(`actual handlers settle ${label} without Cookie or network access`, async () => {
        const h = createHarness({query: async () => tabs});
        try {
            await h.flush();
            assert.equal(h.state.tab, undefined);
            assert.equal(h.state.cookieInfo?.length, 0);
            assert.equal(h.state.loadError, false);
            assert.equal(h.calls.getAll.length, 0);
            assert.equal(h.calls.fetch.length, 0);
        } finally { h.unmount(); }
    });
}

for (const url of ["chrome://extensions/", "about:blank", "file:///fixture", undefined]) {
    test(`actual handlers skip unsupported URL ${String(url)}`, async () => {
        const h = createHarness({tabs: [{id: 1, url}]});
        try {
            await h.flush();
            assert.equal(h.state.cookieInfo?.length, 0);
            assert.equal(h.state.loadError, false);
            assert.equal(h.calls.getAll.length, 0);
            assert.equal(h.calls.fetch.length, 0);
        } finally { h.unmount(); }
    });
}

test("query rejection ends loading with an error, then a later activation recovers", async () => {
    let fails = true;
    const h = createHarness({query: async () => { if (fails) throw new Error("synthetic query rejection"); return []; }});
    try {
        await h.flush();
        assert.equal(h.state.cookieInfo?.length, 0);
        assert.equal(h.state.loadError, true);
        assert.equal(h.calls.getAll.length, 0);
        fails = false;
        h.onActivated.emit();
        await h.flush();
        assert.equal(h.state.loadError, false);
    } finally { h.unmount(); }
});

test("Cookie API rejection ends loading without exposing stale Cookie data", async () => {
    const response = deferred();
    const h = createHarness({getAll: () => response.promise});
    try {
        await h.flush();
        assert.equal(h.state.cookieInfo, undefined);
        response.reject(new Error("synthetic Cookie rejection"));
        await h.flush();
        assert.equal(h.state.cookieInfo?.length, 0);
        assert.equal(h.state.loadError, true);
    } finally { h.unmount(); }
});

test("favicon rejection is nonfatal and synthetic Cookies still load", async () => {
    const h = createHarness({getAll: async () => [{name: "fixture", value: "synthetic"}], fetch: async () => { throw new Error("synthetic offline"); }});
    try {
        await h.flush();
        assert.equal(h.state.cookieInfo[0].name, "fixture");
        assert.equal(h.state.favicon, "fixture-default-icon");
        assert.equal(h.state.loadError, false);
    } finally { h.unmount(); }
});

test("late responses cannot restore old Cookies after the active tab disappears", async () => {
    const response = deferred();
    let tabs = [{id: 1, url: "https://example.invalid/"}];
    const h = createHarness({query: async () => tabs, getAll: () => response.promise});
    try {
        await h.flush();
        tabs = [];
        h.onActivated.emit();
        await h.flush();
        response.resolve([{name: "stale-fixture", value: "synthetic"}]);
        await h.flush();
        assert.equal(h.state.tab, undefined);
        assert.equal(h.state.cookieInfo?.length, 0);
    } finally { h.unmount(); }
});

test("unmount removes browser and document listeners and ignores pending responses", async () => {
    const response = deferred();
    const h = createHarness({getAll: () => response.promise});
    await h.flush();
    h.unmount();
    const before = h.state;
    response.resolve([{name: "late-fixture", value: "synthetic"}]);
    await h.flush();
    assert.equal(h.onActivated.listeners.size, 0);
    assert.equal(h.onUpdated.listeners.size, 0);
    assert.equal(h.updateCookie.listeners.size, 0);
    assert.deepEqual(h.state, before);
});

test("unrelated tab updates do not reset active editor state", async () => {
    const h = createHarness();
    try {
        await h.flush();
        h.onUpdated.emit(2, {status: "complete"});
        h.onUpdated.emit(1, {title: "Fixture title change"});
        await h.flush();
        assert.equal(h.calls.query.length, 1);
        assert.equal(h.calls.getAll.length, 1);
        h.onUpdated.emit(1, {status: "complete"});
        await h.flush();
        assert.equal(h.calls.query.length, 2);
    } finally { h.unmount(); }
});

test("same-tab Cookie refresh preserves editor state while pending and after success", async () => {
    const response = deferred();
    let loads = 0;
    const h = createHarness({getAll: async () => ++loads === 1 ? [{name: "initial", value: "fixture"}] : response.promise});
    try {
        await h.flush();
        const before = h.state;
        h.updateCookie.emit({detail: {action: "edit"}});
        await h.flush();
        assert.equal(h.state.tab, before.tab);
        assert.equal(h.state.cookieInfo, before.cookieInfo);
        assert.equal(h.calls.query.length, 1);
        assert.equal(h.calls.fetch.length, 1);
        response.resolve([{name: "updated", value: "fixture"}]);
        await h.flush();
        assert.equal(h.state.cookieInfo[0].name, "updated");
        assert.equal(h.state.tab, before.tab);
    } finally { h.unmount(); }
});

test("same-tab Cookie refresh rejection keeps the prior editor data and reports failure", async () => {
    let loads = 0;
    const h = createHarness({getAll: async () => {
        if (++loads > 1) throw new Error("Synthetic refresh failure");
        return [{name: "initial", value: "fixture"}];
    }});
    try {
        await h.flush();
        const before = h.state;
        h.updateCookie.emit({detail: {action: "import"}});
        await h.flush();
        assert.equal(h.state.tab, before.tab);
        assert.equal(h.state.cookieInfo, before.cookieInfo);
        assert.equal(h.state.loadError, true);
        assert.equal(h.calls.query.length, 1);
    } finally { h.unmount(); }
});
