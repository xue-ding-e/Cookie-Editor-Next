import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import vm from "node:vm";
import {parseCookieImport} from "../src/utils/cookie_text_import.js";

// Exercise the actual component handler without loading React, a browser, or network clients.
const source = readFileSync(new URL("../src/pages/Extension_sidepanel/components/popup/import_cookie/index.jsx", import.meta.url), "utf8");
const marker = "    const handleImport = ";
const start = source.indexOf(marker);
const end = source.indexOf("    return (", start);
assert.ok(start >= 0 && end > start, "component handler boundaries must remain identifiable");
const handlerSource = source.slice(start + marker.length, end).trim();

async function runImport(input, rejectWrite = false) {
    const written = [];
    const events = [];
    const store = {popup: "import_cookie"};
    const context = {
        parseCookieImport,
        tab: {id: 101, url: "https://example.invalid/"},
        mounted: {current: true}, importSession: {current: 0}, importInProgress: {current: false},
        setImporting: () => {}, closeImporter: () => { store.popup = ""; },
        format: "text", cookies: input, password: "", url: "https://example.invalid/",
        optionImport: [], settingStore: store,
        extension: {getLang: key => key},
        console: {log: () => {}},
        chrome: {cookies: {set: async cookie => {
            written.push(cookie);
            if (rejectWrite) throw new Error("Synthetic Cookie API rejection");
        }}},
        document: {dispatchEvent: event => events.push(event.type)},
        CustomEvent: class { constructor(type) { this.type = type; } },
        googleAnalytics: () => {},
    };
    const handler = vm.runInNewContext(`(${handlerSource})`, context, {timeout: 1000});
    await handler();
    return {written, events, store};
}

test("actual handler makes zero writes when a later Netscape row is malformed", async () => {
    const result = await runImport("example.invalid\tFALSE\t/\tFALSE\t0\tsample\tx\nexample.invalid\tFALSE");
    assert.equal(result.written.length, 0);
    assert.equal(result.store.alert.type, "error");
    assert.deepEqual(result.events, []);
});

test("actual handler stops after API rejection without retrying another import format", async () => {
    const result = await runImport(JSON.stringify([{name: "sample", value: "a=b"}, {name: "other", value: "x"}]), true);
    assert.equal(result.written.length, 1);
    assert.equal(result.written[0].value, "a=b");
    assert.equal(result.store.alert.type, "error");
    assert.deepEqual(result.events, []);
});

test("actual handler writes both parsed header pairs and signals success", async () => {
    const result = await runImport("sample=a=b==; other=hello world");
    assert.equal(result.written.length, 2);
    assert.equal(result.written[0].value, "a=b==");
    assert.equal(result.written[1].value, "hello world");
    assert.equal(result.store.alert.type, "info");
    assert.deepEqual(result.events, ["update_cookie"]);
});

for (const input of ["", " \t\n", "[]", "# Netscape HTTP Cookie File\n# synthetic comment\n"]) {
    test(`actual handler rejects zero-entry import ${JSON.stringify(input)} without closing the draft`, async () => {
        const result = await runImport(input);
        assert.equal(result.written.length, 0);
        assert.equal(result.store.popup, "import_cookie");
        assert.equal(result.store.alert.type, "error");
        assert.deepEqual(result.events, []);
    });
}

test("actual handler preserves a valid empty Cookie value", async () => {
    const result = await runImport("fixture=");
    assert.equal(result.written.length, 1);
    assert.equal(result.written[0].value, "");
    assert.equal(result.store.alert.type, "info");
});
