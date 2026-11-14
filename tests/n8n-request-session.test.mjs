import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const raw = readFileSync(new URL("../src/services/n8n.js", import.meta.url), "utf8");
const source = raw.replace(/^import .*;\n/gm, "").replace("export const n8nService =", "const n8nService =");
const fixture = {name: "fixture", value: "synthetic-value"};
const request = {type: "get_cookies", request_id: "synthetic-request-a", url: "https://source.example.invalid/alpha"};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return {promise, resolve, reject};
};
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(setImmediate); };
const responses = socket => socket.sent.filter(message => ["cookies_result", "cookies_error"].includes(message.type));

function harness() {
    const sockets = [], queries = [], encryptions = [], broadcasts = [], historyWrites = [], alarms = [];
    const storage = {n8n_history: []};
    const read = deferred();
    let nextGet, nextSet, nextClear, nextHistoryWriteError;
    const timers = new Map();
    let timerId = 0;
    class Socket {
        static OPEN = 1;
        static CONNECTING = 0;
        constructor(url) {
            assert.equal(url, "wss://relay.example.invalid/");
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
        }
        send(data) { this.sent.push(JSON.parse(data)); }
        close() { this.readyState = 3; }
        open() { this.readyState = 1; this.onopen?.(); }
        receive(payload = request) { this.onmessage?.({data: JSON.stringify(payload)}); }
    }
    const context = vm.createContext({URL, Date, JSON, Boolean, Promise, String, Math, Error,
        WebSocket: Socket,
        chrome: {
            runtime: {id: "synthetic-extension", sendMessage: async message => { broadcasts.push(message); }},
            alarms: {
                create: async (name, options) => { alarms.push({name, options}); },
                clear: async () => { const pause = nextClear; nextClear = null; if (pause) await pause.promise; },
            },
            storage: {local: {
                get(keys, done) {
                    const snapshot = Object.fromEntries(keys.map(key => [key, storage[key]]));
                    if (nextGet?.matches(keys)) {
                        const pause = nextGet; nextGet = null;
                        pause.release = () => done(snapshot);
                    } else done(snapshot);
                },
                set(data, done) {
                    if (nextHistoryWriteError && "n8n_history" in data) {
                        const error = nextHistoryWriteError; nextHistoryWriteError = null;
                        throw error;
                    }
                    if ("n8n_history" in data) historyWrites.push(data.n8n_history);
                    if (nextSet && "n8n_history" in data) {
                        const pause = nextSet; nextSet = null;
                        pause.release = () => { Object.assign(storage, data); done(); };
                    } else { Object.assign(storage, data); done(); }
                },
                remove(keys, done) { for (const key of keys) delete storage[key]; done(); },
            }},
            cookies: {getAll: async details => { queries.push(details); return read.promise; }},
        },
        // Only the lifecycle is real; all data, storage, sockets and encryption are doubles.
        btoa: text => Buffer.from(text, "binary").toString("base64"),
        CryptoJS: {AES: {encrypt(data, password) {
            encryptions.push({data, password});
            return {toString: () => "synthetic-ciphertext"};
        }}},
        getN8nWsUrl: () => "wss://relay.example.invalid/",
        checkN8nPermissions: async () => true,
        fetch: () => { throw Error("No real network allowed"); },
        setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
        clearTimeout: id => timers.delete(id),
        setInterval: callback => { timers.set(++timerId, callback); return timerId; },
        clearInterval: id => timers.delete(id),
    });
    vm.runInContext(source + "\nglobalThis.__service=n8nService;", context, {timeout: 1000});
    const service = context.__service;
    return {service, sockets, queries, encryptions, broadcasts, historyWrites, storage, read, alarms,
        async connect(password = "synthetic-password-a", open = true) {
            await service.connect(password, {awaitConnected: false});
            const socket = sockets.at(-1);
            if (open) socket.open();
            return socket;
        },
        pauseGet(matches) { nextGet = {matches}; return nextGet; },
        pauseHistoryWrite() { nextSet = {}; return nextSet; },
        failNextHistoryWrite(error) { nextHistoryWriteError = error; },
        pauseAlarmClear() { nextClear = deferred(); return nextClear; },
    };
}

test("n8n preserves a current connection's connected handshake", async () => {
    const h = harness(), a = await h.connect();
    a.receive({type: "connected", client_key: "synthetic-client"}); await flush();
    assert.equal(h.storage.n8n_connected, true);
    assert.equal(h.storage.n8n_client_key, "synthetic-client");
    assert.equal(h.alarms.length, 1);
    assert.equal(h.alarms[0].name, "n8n_keepalive");
    assert.equal(h.broadcasts.length, 2);
    assert.equal(h.queries.length, 0);
    assert.equal(h.encryptions.length, 0);
});

test("n8n preserves a current connection's ping and pong protocol", async () => {
    const h = harness(), a = await h.connect();
    a.receive({type: "ping"}); await flush();
    assert.deepEqual(a.sent.at(-1), {type: "pong"});
    assert.equal(h.queries.length, 0);
    assert.equal(h.historyWrites.length, 0);
    assert.equal(h.broadcasts.length, 0);
});

for (const outcome of ["success", "error"]) test(`n8n keeps a stable connection's ${outcome} response and history`, async () => {
    const h = harness(), a = await h.connect();
    a.receive(); await flush();
    if (outcome === "success") h.read.resolve([fixture]); else h.read.reject(new Error("Synthetic query failure"));
    await flush();
    assert.equal(responses(a).length, 1);
    assert.equal(responses(a)[0].type, outcome === "success" ? "cookies_result" : "cookies_error");
    assert.equal(responses(a)[0].request_id, request.request_id);
    assert.equal(h.storage.n8n_history.length, 1);
    assert.equal(h.storage.n8n_history[0].status, outcome);
    assert.equal(h.encryptions.length, outcome === "success" ? 1 : 0);
    assert.equal(h.broadcasts.length, 2);
});

for (const outcome of ["success", "error"]) for (const replacement of ["open", "connecting", "none"]) {
    test(`n8n drops old ${outcome} completion with ${replacement} replacement`, async () => {
        const h = harness(), a = await h.connect();
        a.receive(); await flush(); assert.equal(h.queries.length, 1);
        await h.service.disconnect(true);
        const b = replacement === "none" ? null : await h.connect("synthetic-password-b", replacement === "open");
        const broadcastCount = h.broadcasts.length;
        if (outcome === "success") h.read.resolve([fixture]); else h.read.reject(new Error("Synthetic query failure"));
        await flush();
        assert.equal(responses(a).length, 0);
        if (b) assert.equal(responses(b).length, 0);
        assert.equal(h.encryptions.length, 0);
        assert.equal(h.historyWrites.length, 0);
        assert.equal(h.broadcasts.length, broadcastCount);
    });
}

test("n8n invalidates at disconnect intent while password read and alarm cleanup are pending", async () => {
    const h = harness(), a = await h.connect();
    const passwordRead = h.pauseGet(keys => keys.length === 1 && keys[0] === "n8n_password");
    a.receive(); await flush(); assert.ok(passwordRead.release);
    const alarm = h.pauseAlarmClear();
    const closing = h.service.disconnect(true);
    passwordRead.release(); await flush();
    assert.equal(a.readyState, 1, "The fake alarm still blocks physical socket close");
    assert.equal(h.queries.length, 0);
    assert.equal(responses(a).length, 0);
    assert.equal(h.historyWrites.length, 0);
    alarm.resolve(); await closing;
});

test("n8n rejects a queued old message while disconnect has not closed its socket", async () => {
    const h = harness(), a = await h.connect();
    const oldHandler = a.onmessage, alarm = h.pauseAlarmClear();
    const closing = h.service.disconnect(true);
    oldHandler({data: JSON.stringify(request)}); await flush();
    assert.equal(a.readyState, 1);
    assert.equal(h.queries.length, 0);
    assert.equal(h.historyWrites.length, 0);
    alarm.resolve(); await closing;
});

test("n8n rejects a retained message callback from a replaced connection", async () => {
    const h = harness(), a = await h.connect("synthetic-password-a", false);
    const oldHandler = a.onmessage;
    const b = await h.connect("synthetic-password-b");
    oldHandler({data: JSON.stringify(request)}); await flush();
    assert.notEqual(a, b);
    assert.equal(h.queries.length, 0);
    assert.equal(responses(b).length, 0);
});

test("n8n drops a pending request after natural socket closure", async () => {
    const h = harness(), a = await h.connect();
    a.receive(); await flush();
    a.readyState = 3; await a.onclose();
    h.read.resolve([fixture]); await flush();
    assert.equal(h.encryptions.length, 0);
    assert.equal(h.historyWrites.length, 0);
    assert.equal(responses(a).length, 0);
});

test("n8n does not start a history write after its pending history read becomes stale", async () => {
    const h = harness(), a = await h.connect();
    const historyRead = h.pauseGet(keys => keys.length === 1 && keys[0] === "n8n_history");
    a.receive(); await flush(); h.read.resolve([fixture]); await flush();
    assert.equal(responses(a).length, 1); assert.ok(historyRead.release);
    await h.service.disconnect(true);
    const broadcastCount = h.broadcasts.length;
    historyRead.release(); await flush();
    assert.equal(h.historyWrites.length, 0);
    assert.equal(h.broadcasts.length, broadcastCount);
});

test("n8n cannot retract a started history write but suppresses its stale completion broadcast", async () => {
    const h = harness(), a = await h.connect();
    const historyWrite = h.pauseHistoryWrite();
    a.receive(); await flush(); h.read.resolve([fixture]); await flush();
    assert.equal(h.historyWrites.length, 1); assert.ok(historyWrite.release);
    await h.service.disconnect(true);
    const broadcastCount = h.broadcasts.length;
    historyWrite.release(); await flush();
    assert.equal(h.historyWrites.length, 1);
    assert.equal(h.storage.n8n_history.length, 1, "A write already issued is not rolled back");
    assert.equal(h.broadcasts.length, broadcastCount);
});

test("n8n suppresses a status broadcast whose read completed after disconnection", async () => {
    const h = harness(), a = await h.connect();
    const statusRead = h.pauseGet(keys => keys.length > 1 && keys.includes("n8n_password"));
    a.receive(); await flush(); h.read.resolve([fixture]); await flush();
    assert.ok(statusRead.release); assert.equal(h.historyWrites.length, 1);
    await h.service.disconnect(true);
    const broadcastCount = h.broadcasts.length;
    statusRead.release(); await flush();
    assert.equal(h.broadcasts.length, broadcastCount);
});

for (const outcome of ["success", "error"]) test(`n8n history mutation: retains both concurrent ${outcome} requests`, async () => {
    const h = harness(), a = await h.connect();
    a.receive({...request, request_id: "synthetic-first"});
    a.receive({...request, request_id: "synthetic-second"});
    await flush();
    assert.equal(h.queries.length, 2);
    if (outcome === "success") h.read.resolve([fixture]);
    else h.read.reject(new Error("Synthetic query failure"));
    await flush();
    assert.equal(responses(a).length, 2);
    assert.equal(h.historyWrites.length, 2);
    assert.deepEqual(Array.from(h.storage.n8n_history, entry => entry.id).sort(), ["synthetic-first", "synthetic-second"]);
    assert.ok(h.storage.n8n_history.every(entry => entry.status === outcome));
});

test("n8n history mutation: clear follows an already-started history append", async () => {
    const h = harness(), a = await h.connect();
    const historyRead = h.pauseGet(keys => keys.length === 1 && keys[0] === "n8n_history");
    a.receive(); await flush(); h.read.resolve([fixture]); await flush();
    assert.equal(responses(a).length, 1);
    assert.ok(historyRead.release);
    const clearing = h.service.clearHistory();
    await flush();
    historyRead.release();
    await clearing; await flush();
    assert.equal(h.storage.n8n_history.length, 0);
});

test("n8n history mutation: preserves the 50-entry limit and sequential clear", async () => {
    const h = harness(), a = await h.connect();
    h.storage.n8n_history = Array.from({length: 50}, (_, i) => ({id: `synthetic-old-${i}`}));
    a.receive(); await flush(); h.read.resolve([fixture]); await flush();
    assert.equal(h.storage.n8n_history.length, 50);
    assert.equal(h.storage.n8n_history[0].id, request.request_id);
    assert.equal(h.storage.n8n_history[49].id, "synthetic-old-48");
    await h.service.clearHistory();
    assert.equal(h.storage.n8n_history.length, 0);
});

test("n8n history mutation: keeps requests appended after a queued clear", async () => {
    const h = harness(), a = await h.connect();
    const historyRead = h.pauseGet(keys => keys.length === 1 && keys[0] === "n8n_history");
    a.receive({...request, request_id: "synthetic-before-clear"});
    await flush(); h.read.resolve([fixture]); await flush();
    assert.ok(historyRead.release);
    const clearing = h.service.clearHistory();
    a.receive({...request, request_id: "synthetic-after-clear"});
    await flush();
    assert.equal(responses(a).length, 2);
    historyRead.release();
    await clearing; await flush();
    assert.deepEqual(Array.from(h.storage.n8n_history, entry => entry.id), ["synthetic-after-clear"]);
});

test("n8n history mutation: drops queued entries after their connection retires", async () => {
    const h = harness(), a = await h.connect();
    const historyRead = h.pauseGet(keys => keys.length === 1 && keys[0] === "n8n_history");
    a.receive({...request, request_id: "synthetic-first"});
    a.receive({...request, request_id: "synthetic-queued"});
    await flush(); h.read.resolve([fixture]); await flush();
    assert.ok(historyRead.release);
    assert.equal(responses(a).length, 2);
    await h.service.disconnect(true);
    const broadcastCount = h.broadcasts.length;
    historyRead.release(); await flush();
    assert.equal(h.historyWrites.length, 0);
    assert.equal(h.broadcasts.length, broadcastCount);
});

test("n8n history mutation: a failed clear does not poison later mutations", async () => {
    const h = harness();
    h.storage.n8n_history = [{id: "synthetic-kept"}];
    h.failNextHistoryWrite(new Error("Synthetic history write failure"));
    await assert.rejects(h.service.clearHistory(), /Synthetic history write failure/);
    assert.equal(h.storage.n8n_history.length, 1);
    await h.service.clearHistory();
    assert.equal(h.storage.n8n_history.length, 0);
    assert.equal(h.historyWrites.length, 1);
});
