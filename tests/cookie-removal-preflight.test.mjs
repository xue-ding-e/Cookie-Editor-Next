import test from "node:test";
import assert from "node:assert/strict";
import {hasRemovalIdentity, hasUniqueRemovalMatch} from "../src/utils/cookie_removal.js";

const fixture = () => ({name: "fixture", value: "synthetic", domain: "example.invalid", path: "/", hostOnly: true, secure: true, storeId: "0"});

for (const [label, fields] of [
    ["host-only", {}], ["domain", {domain: ".example.invalid", hostOnly: false}],
    ["empty name", {name: ""}], ["non-secure", {secure: false}],
]) test(`accepts one matching complete unpartitioned ${label} identity`, () => {
    const original = {...fixture(), ...fields};
    assert.equal(hasRemovalIdentity(original), true);
    assert.equal(hasUniqueRemovalMatch(original, [{...original}]), true);
});

for (const [label, mutate] of [
    ["missing name", x => delete x.name], ["non-string name", x => { x.name = 0; }],
    ["missing domain", x => delete x.domain], ["empty domain", x => { x.domain = ""; }],
    ["relative path", x => { x.path = "relative"; }], ["missing path", x => delete x.path],
    ["unknown hostOnly", x => delete x.hostOnly], ["string hostOnly", x => { x.hostOnly = "true"; }],
    ["unknown secure", x => delete x.secure], ["string secure", x => { x.secure = "true"; }],
    ["missing store", x => delete x.storeId], ["empty store", x => { x.storeId = ""; }],
    ["numeric store", x => { x.storeId = 0; }],
    ["partition key", x => { x.partitionKey = {topLevelSite: "https://example.invalid"}; }],
    ["null partition key", x => { x.partitionKey = null; }],
    ["explicit undefined partition key", x => { x.partitionKey = undefined; }],
]) test(`refuses ${label} in either selection or candidate`, () => {
    const invalid = fixture(); mutate(invalid);
    assert.equal(hasRemovalIdentity(invalid), false);
    assert.equal(hasUniqueRemovalMatch(invalid, [fixture()]), false);
    assert.equal(hasUniqueRemovalMatch(fixture(), [invalid]), false);
});

for (const key of ["name", "domain", "path", "hostOnly", "secure", "storeId"]) test(`refuses a changed ${key} rather than normalizing it`, () => {
    const candidate = fixture();
    candidate[key] = typeof candidate[key] === "boolean" ? !candidate[key] : candidate[key] + "other";
    assert.equal(hasUniqueRemovalMatch(fixture(), [candidate]), false);
});

for (const [label, matches] of [
    ["missing response", undefined], ["null response", null], ["object response", fixture()], ["string response", "synthetic"],
    ["empty response", []], ["two identical matches", [fixture(), fixture()]],
    ["same-name path collision", [fixture(), {...fixture(), path: "/account"}]],
    ["same-name domain collision", [fixture(), {...fixture(), domain: ".example.invalid", hostOnly: false}]],
    ["malformed extra candidate", [fixture(), null]], ["one malformed candidate", [{}]],
]) test(`refuses ${label} without filtering candidates away`, () => {
    assert.equal(hasUniqueRemovalMatch(fixture(), matches), false);
});

test("does not confuse value or lifetime changes with exposed identity or mutate inputs", () => {
    const selected = Object.freeze(fixture());
    const candidate = Object.freeze({...selected, value: "synthetic-new", expirationDate: 2000000000});
    const matches = Object.freeze([candidate]);
    assert.equal(hasUniqueRemovalMatch(selected, matches), true);
    assert.equal(selected.value, "synthetic");
});

test("rejects absent, array and function selections", () => {
    for (const selected of [null, undefined, [], () => {}]) {
        assert.equal(hasRemovalIdentity(selected), false);
        assert.equal(hasUniqueRemovalMatch(selected, [fixture()]), false);
    }
});
