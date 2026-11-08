import test from "node:test";
import assert from "node:assert/strict";
import {canSetCookieWithoutRemoval} from "../src/utils/cookie_edit.js";
import {shouldIncludeDomain} from "../src/utils/cookie_import.js";

// Pure synthetic identity checks; no browser, Cookies, network or persistence is accessed.
function fixture(overrides = {}, url = "https://example.invalid/account/view") {
    const original = {name: "fixture", domain: "example.invalid", path: "/", hostOnly: true, storeId: "fixture-store", ...overrides};
    const draft = {...original, value: "updated-synthetic-value"};
    const details = {name: draft.name, path: draft.path, value: draft.value, storeId: original.storeId, url,
        ...(shouldIncludeDomain(draft) ? {domain: draft.domain} : {})};
    return {original, draft, details};
}
const eligible = h => canSetCookieWithoutRemoval(h.original, h.draft, h.details);

for (const [label, original, url] of [
    ["host-only root path", {}, "https://example.invalid/account/view"],
    ["host-only non-root path", {path: "/account"}, "https://example.invalid/account/view"],
    ["domain Cookie from a subdomain", {hostOnly: false, domain: ".example.invalid"}, "https://sub.example.invalid/account/view"],
    ["explicit domain without a leading dot", {hostOnly: false}, "https://example.invalid/"],
    ["unchanged __Host- scope", {name: "__Host-fixture", secure: true}, "https://example.invalid/"],
]) test(`allows direct set with unchanged exposed ${label}`, () => {
    assert.equal(eligible(fixture(original, url)), true);
});

for (const [label, mutate] of [
    ["renamed draft", h => { h.draft.name = h.details.name = "renamed"; }],
    ["changed path", h => { h.draft.path = h.details.path = "/new-path"; }],
    ["changed domain", h => { h.draft.domain = "second.invalid"; }],
    ["changed hostOnly", h => { h.draft.hostOnly = false; }],
    ["different outgoing name", h => { h.details.name = "other"; }],
    ["different outgoing path", h => { h.details.path = "/other"; }],
    ["different outgoing store", h => { h.details.storeId = "different-store"; }],
    ["host-only target mismatch", h => { h.details.url = "https://second.invalid/"; }],
    ["unexpected outgoing Domain", h => { h.details.domain = h.original.domain; }],
    ["explicit undefined outgoing Domain", h => { h.details.domain = undefined; }],
    ["legacy unknown hostOnly", h => { h.original.hostOnly = h.draft.hostOnly = undefined; }],
    ["missing original store", h => { h.original.storeId = undefined; }],
    ["missing original domain", h => { h.original.domain = h.draft.domain = ""; }],
    ["non-string name", h => { h.original.name = h.draft.name = h.details.name = null; }],
    ["non-explicit path", h => { h.original.path = h.draft.path = h.details.path = "relative"; }],
    ["original partition key", h => { h.original.partitionKey = {topLevelSite: "https://example.invalid"}; }],
    ["draft partition key", h => { h.draft.partitionKey = {topLevelSite: "https://example.invalid"}; }],
    ["outgoing partition key", h => { h.details.partitionKey = {topLevelSite: "https://example.invalid"}; }],
    ["null is not proven absent partition key", h => { h.original.partitionKey = null; }],
    ["malformed target URL", h => { h.details.url = "https://[invalid"; }],
    ["unsupported target scheme", h => { h.details.url = "file:///synthetic"; }],
]) test(`retains the existing removal route for ${label}`, () => {
    const h = fixture(); mutate(h); assert.equal(eligible(h), false);
});

test("checks the effective outgoing domain after __Host- policy suppresses it", () => {
    const h = fixture({hostOnly: false, domain: ".example.invalid", name: "__Host-fixture"});
    assert.equal(Object.hasOwn(h.details, "domain"), false);
    assert.equal(eligible(h), false);
});

test("rejects an omitted or altered outgoing Domain for a domain Cookie", () => {
    const h = fixture({hostOnly: false, domain: ".example.invalid"});
    delete h.details.domain;
    assert.equal(eligible(h), false);
    h.details.domain = ".second.invalid";
    assert.equal(eligible(h), false);
});

test("does not silently repair security flags or forbid intentional expiration", () => {
    const h = fixture({name: "__Host-fixture", secure: true});
    h.draft.secure = h.details.secure = false;
    h.draft.expirationDate = h.details.expirationDate = 0;
    assert.equal(eligible(h), true);
    assert.equal(h.details.secure, false);
    assert.equal(h.details.expirationDate, 0);
});

test("uses the captured original store even if global draft metadata differs", () => {
    const h = fixture(); h.draft.storeId = "later-draft-store";
    assert.equal(eligible(h), true);
    assert.equal(h.details.storeId, "fixture-store");
});
