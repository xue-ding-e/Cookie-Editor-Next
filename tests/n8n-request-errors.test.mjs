import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";

const raw = readFileSync(new URL("../src/services/n8n.js", import.meta.url), "utf8");
// Execute the actual service handlers with every browser/network boundary replaced.
const source = raw.replace(/^import .*;\n/gm, "").replace("export const n8nService =", "const n8nService =");

function harness({cookies = [], readError, open = true} = {}) {
    const sent = [], queries = [], broadcasts = [];
    const storage = {n8n_password: "synthetic-test-password", n8n_history: []};
    const context = vm.createContext({URL, Date, JSON, Boolean, Promise, String, Math, Error,
        WebSocket: {OPEN: 1},
        chrome: {
            storage: {local: {
                get(keys, done) { done(Object.fromEntries(keys.map(key => [key, storage[key]]))); },
                set(data, done) { Object.assign(storage, data); done(); },
            }},
            cookies: {getAll: async details => {
                queries.push(details);
                if (readError) throw readError;
                return cookies;
            }},
            runtime: {sendMessage: async message => { broadcasts.push(message); }},
        },
        // The encoder remains a boundary double; these tests do not assess encryption.
        btoa: text => Buffer.from(text, "binary").toString("base64"),
        CryptoJS: {AES: {encrypt: () => ({toString: () => "synthetic-ciphertext"})}},
        getN8nWsUrl: () => { throw Error("No connection allowed"); },
        checkN8nPermissions: () => { throw Error("No permissions call allowed"); },
        fetch: () => { throw Error("No network allowed"); },
        setTimeout: () => { throw Error("No timers allowed"); },
        setInterval: () => { throw Error("No timers allowed"); },
        __socket: {readyState: open ? 1 : 3, send(data) { sent.push(JSON.parse(data)); }},
    });
    vm.runInContext(source + "\nsocket=__socket; globalThis.__handle=handleSocketMessage;", context, {timeout: 1000});
    return {sent, queries, broadcasts, storage,
        send: payload => context.__handle({data: JSON.stringify(payload)}),
        sendRaw: data => context.__handle({data}),
    };
}

for (const [label, url] of [["malformed URL", "https://["], ["non-string URL", 42], ["invalid host", "https://"]]) {
    test(`n8n reports ${label} without reading Cookies`, async () => {
        const h = harness();
        await assert.doesNotReject(h.send({type: "get_cookies", request_id: "synthetic-request", url}));
        assert.equal(h.queries.length, 0);
        assert.equal(h.sent.length, 1);
        assert.equal(h.sent[0].type, "cookies_error");
        assert.equal(h.sent[0].request_id, "synthetic-request");
        assert.ok(h.sent[0].message);
        assert.equal(h.storage.n8n_history.length, 1);
        assert.equal(h.storage.n8n_history[0].status, "error");
        assert.equal(h.storage.n8n_history[0].cookieCount, 0);
        assert.equal(h.broadcasts.length, 2);
    });
}

for (const [label, url, expected] of [["bare domain", "example.invalid/path", "https://example.invalid/path"], ["HTTPS", "https://example.invalid/path", "https://example.invalid/path"], ["HTTP", "http://example.invalid/path", "http://example.invalid/path"]]) {
    test(`n8n preserves valid ${label} request and response fields`, async () => {
        const h = harness({cookies: [{name: "fixture", value: "synthetic"}]});
        await h.send({action: "get_cookies", requestId: "synthetic-request", url});
        assert.equal(h.queries.length, 1);
        assert.equal(h.queries[0].url, expected);
        assert.deepEqual(h.sent, [{type: "cookies_result", request_id: "synthetic-request", data: "synthetic-ciphertext", domain: "example.invalid", url: expected}]);
        assert.equal(h.storage.n8n_history[0].status, "success");
        assert.equal(h.storage.n8n_history[0].cookieCount, 1);
    });
}

test("n8n preserves a supplied domain label and existing API failure reporting", async () => {
    const h = harness({readError: new Error("Synthetic read failure")});
    await h.send({type: "get_cookies", request_id: "fixture", url: "https://example.invalid/", domain: "synthetic-label"});
    assert.equal(h.queries.length, 1);
    assert.equal(h.sent[0].domain, "synthetic-label");
    assert.equal(h.sent[0].message, "Synthetic read failure");
    assert.equal(h.storage.n8n_history[0].status, "error");
});

test("n8n keeps empty URL and empty result errors observable", async () => {
    for (const url of ["", "https://example.invalid/"]) {
        const h = harness();
        await h.send({type: "get_cookies", request_id: "fixture", url});
        assert.equal(h.sent[0].type, "cookies_error");
        assert.equal(h.sent[0].message, url ? "No cookies found for this url" : "Missing url");
        assert.equal(h.queries.length, url ? 1 : 0);
        assert.equal(h.storage.n8n_history[0].status, "error");
    }
});

test("n8n ignores an inactive connection's invalid URL request", async () => {
    const h = harness({open: false});
    await assert.doesNotReject(h.send({type: "get_cookies", request_id: "fixture", url: "https://["}));
    assert.equal(h.sent.length, 0);
    assert.equal(h.queries.length, 0);
    assert.equal(h.storage.n8n_history.length, 0);
});

test("n8n ignores malformed JSON without querying Cookies", async () => {
    const h = harness();
    await h.sendRaw("{");
    assert.equal(h.queries.length, 0);
    assert.equal(h.sent.length, 0);
    assert.equal(h.storage.n8n_history.length, 0);
});
