import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const raw = readFileSync(new URL("../src/services/n8n.js", import.meta.url), "utf8");
const source = raw.replace(/^import .*;\n/gm, "").replace("export const n8nService =", "const n8nService =");
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
};

function harness() {
    const storage = {n8n_history: []}, sockets = [], alarmStarts = [], intervals = [], broadcasts = [];
    const activeIntervals = new Set(), forbidden = {cookies: 0, crypto: 0, fetch: 0};
    const timeouts = new Map();
    let timeoutId = 0;
    let heldWrite, heldPermission, heldAlarm, heldStatus, clearCount = 0, alarmLive = false;
    class Socket {
        static OPEN = 1;
        static CONNECTING = 0;
        constructor(url) {
            assert.equal(url, "wss://relay.example.invalid/");
            this.readyState = 0; this.sent = []; sockets.push(this);
        }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; }
        open() { this.readyState = 1; this.onopen?.(); }
        acknowledge(clientKey) { this.onmessage?.({data: JSON.stringify({type: "connected", client_key: clientKey})}); }
    }
    const context = vm.createContext({URL, Date, JSON, Boolean, Promise, String, Math, Error, WebSocket: Socket,
        chrome: {
            runtime: {id: "synthetic-extension", sendMessage: async message => { broadcasts.push(message); }},
            alarms: {
                create: async (name, options) => {
                    alarmStarts.push({name, options});
                    if (heldAlarm) { const p = heldAlarm; heldAlarm = null; p.blocked = true; await p.promise; }
                    alarmLive = true;
                },
                clear: async () => { clearCount++; alarmLive = false; },
            },
            storage: {local: {
                get(keys, done) {
                    const snapshot = Object.fromEntries(keys.map(key => [key, storage[key]]));
                    if (heldStatus && keys.length > 1 && keys.includes("n8n_password")) {
                        const p = heldStatus; heldStatus = null; p.blocked = true; p.release = () => done(snapshot);
                    } else done(snapshot);
                },
                set(data, done) {
                    Object.assign(storage, data);
                    if (heldWrite && "n8n_connected_at" in data) {
                        const p = heldWrite; heldWrite = null; p.blocked = true; p.release = done;
                    } else done();
                },
                remove(keys, done) { for (const key of keys) delete storage[key]; done(); },
            }},
            cookies: {getAll() { forbidden.cookies++; throw Error("No Cookie query allowed"); }},
        },
        CryptoJS: {AES: {encrypt() { forbidden.crypto++; throw Error("No encryption allowed"); }}},
        getN8nWsUrl: () => "wss://relay.example.invalid/",
        checkN8nPermissions: async () => {
            if (heldPermission) { const p = heldPermission; heldPermission = null; p.blocked = true; await p.promise; return p.result; }
            return true;
        },
        fetch() { forbidden.fetch++; throw Error("No network allowed"); },
        setTimeout: (callback, delay) => { timeouts.set(++timeoutId, {callback, delay}); return timeoutId; },
        clearTimeout: id => timeouts.delete(id),
        setInterval: callback => { intervals.push(callback); activeIntervals.add(intervals.length); return intervals.length; },
        clearInterval: id => activeIntervals.delete(id),
    });
    vm.runInContext(source + "\nglobalThis.__service=n8nService;", context, {timeout: 1000});
    const service = context.__service;
    return {service, storage, sockets, alarmStarts, intervals, activeIntervals, broadcasts, forbidden,
        get clearCount() { return clearCount; },
        get alarmLive() { return alarmLive; },
        async runReconnect() {
            const timer = [...timeouts.entries()].find(([, value]) => value.delay < 15000);
            assert.ok(timer, "A synthetic reconnect timer must exist");
            timeouts.delete(timer[0]); await timer[1].callback(); await flush();
        },
        async connect(password = "synthetic-password-a", awaitConnected = false) {
            const count = sockets.length;
            const result = {settled: false};
            result.promise = service.connect(password, {awaitConnected});
            result.promise.then(value => { result.settled = true; result.value = value; }, error => { result.settled = true; result.error = error; });
            await flush();
            assert.equal(sockets.length, count + 1);
            result.socket = sockets.at(-1); result.socket.open();
            return result;
        },
        pause(stage, result = true) {
            const p = {...deferred(), result, blocked: false}; p.release = p.resolve;
            if (stage === "storage") heldWrite = p;
            else if (stage === "permission") heldPermission = p;
            else if (stage === "alarm") heldAlarm = p;
            else if (stage === "status") heldStatus = p;
            else throw Error("Unknown synthetic stage");
            return p;
        },
    };
}

test("n8n resolves a connection only after its own connected acknowledgement", async () => {
    const h = harness(), a = await h.connect("synthetic-password-a", true);
    assert.equal(a.settled, false);
    a.socket.acknowledge("synthetic-client-a"); await flush();
    assert.equal(a.settled, true); assert.equal(a.error, undefined);
    assert.equal(a.value.connected, true); assert.equal(a.value.clientKey, "synthetic-client-a");
    assert.equal(h.alarmStarts.length, 1); assert.equal(h.activeIntervals.size, 1);
    assert.deepEqual(h.forbidden, {cookies: 0, crypto: 0, fetch: 0});
});

test("n8n preserves completion of a pending connect through an automatic replacement handshake", async () => {
    const h = harness(), a = await h.connect("synthetic-password-a", true);
    a.socket.readyState = 3; await a.socket.onclose();
    assert.equal(a.settled, false);
    await h.runReconnect(); assert.equal(h.sockets.length, 2);
    const b = h.sockets[1]; b.open(); await flush();
    assert.equal(a.settled, false, "Opening the replacement socket alone is not an acknowledgement");
    b.acknowledge("synthetic-client-after-reconnect"); await flush();
    assert.equal(a.settled, true); assert.equal(a.error, undefined);
    assert.equal(a.value.clientKey, "synthetic-client-after-reconnect");
    assert.equal(h.activeIntervals.size, 1);
    assert.deepEqual(h.forbidden, {cookies: 0, crypto: 0, fetch: 0});
});

for (const stage of ["storage", "permission", "alarm", "status"]) for (const replacement of [false, true]) {
    test(`n8n drops a stale connected continuation after ${stage}, replacement=${replacement}`, async () => {
        const h = harness(), a = await h.connect();
        const pause = h.pause(stage);
        a.socket.acknowledge("synthetic-client-a"); await flush(); assert.equal(pause.blocked, true);
        await h.service.disconnect(true);
        const b = replacement ? await h.connect("synthetic-password-b", true) : null;
        const oldCounts = {alarms: h.alarmStarts.length, intervals: h.intervals.length, broadcasts: h.broadcasts.length, clears: h.clearCount};
        pause.release(); await flush();
        assert.equal(h.alarmStarts.length, oldCounts.alarms);
        assert.equal(h.intervals.length, oldCounts.intervals);
        assert.equal(h.activeIntervals.size, 0);
        assert.equal(h.broadcasts.length, oldCounts.broadcasts);
        assert.equal(h.clearCount, oldCounts.clears, "An old continuation cannot clear a newer shared alarm");
        if (stage === "storage" || stage === "permission") assert.equal(h.alarmStarts.length, 0);
        if (stage === "alarm") assert.equal(h.alarmLive, true, "Already issued alarm creation may finish; it is not rolled back");
        if (b) {
            assert.equal(b.settled, false, "No connected acknowledgement has arrived for B");
            b.socket.acknowledge("synthetic-client-b"); await flush();
            assert.equal(b.settled, true); assert.equal(b.error, undefined);
            assert.equal(b.value.clientKey, "synthetic-client-b");
            assert.equal(h.activeIntervals.size, 1);
        }
        assert.deepEqual(h.forbidden, {cookies: 0, crypto: 0, fetch: 0});
    });
}

test("n8n does not clear or restart B's keepalive when A's issued alarm finishes late", async () => {
    const h = harness(), a = await h.connect();
    const pause = h.pause("alarm");
    a.socket.acknowledge("synthetic-client-a"); await flush(); assert.equal(pause.blocked, true);
    await h.service.disconnect(true);
    const b = await h.connect("synthetic-password-b", true);
    b.socket.acknowledge("synthetic-client-b"); await flush(); assert.equal(b.settled, true);
    const before = {intervals: h.intervals.length, broadcasts: h.broadcasts.length, clears: h.clearCount};
    pause.release(); await flush();
    assert.equal(h.intervals.length, before.intervals);
    assert.equal(h.activeIntervals.size, 1);
    assert.equal(h.clearCount, before.clears);
    assert.equal(h.broadcasts.length, before.broadcasts);
    assert.deepEqual(h.forbidden, {cookies: 0, crypto: 0, fetch: 0});
});

test("n8n retains the existing no-keepalive behavior when permission is unavailable", async () => {
    const h = harness(), a = await h.connect("synthetic-password-a", true);
    const pause = h.pause("permission", false);
    a.socket.acknowledge("synthetic-client-a"); await flush(); pause.release(); await flush();
    assert.equal(a.settled, true); assert.equal(a.value.clientKey, "synthetic-client-a");
    assert.equal(h.alarmStarts.length, 0); assert.equal(h.activeIntervals.size, 0);
    assert.deepEqual(h.forbidden, {cookies: 0, crypto: 0, fetch: 0});
});
