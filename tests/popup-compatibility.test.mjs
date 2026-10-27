import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
const read = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const manifest = JSON.parse(read("src/manifest.json"));
test("toolbar action opens an included popup without sidePanel permission", () => {
  assert.equal(manifest.action.default_popup, "pages/popup.html");
  assert.ok(existsSync(new URL("../" + manifest.action.default_popup, import.meta.url)));
  assert.ok(!manifest.permissions.includes("sidePanel"));
  assert.ok(!("side_panel" in manifest));
});
test("background does not invoke unavailable sidePanel APIs", () => {
  assert.doesNotMatch(read("src/background.js"), /chrome\.sidePanel/);
  assert.doesNotMatch(read("src/background.js"), /chrome\.action\.onClicked/);
});
test("popup reuses the upstream editor and loads fixed-size styling", () => {
  assert.match(read("pages/popup.html"), /src\/entries\/popup\.jsx/);
  assert.match(read("src/entries/popup.jsx"), /import "\.\.\/popup\.css"/);
  assert.match(read("src/entries/popup.jsx"), /<ExtensionSidePanel \/>/);
  assert.match(read("src/popup.css"), /width: 640px/);
  assert.match(read("src/popup.css"), /height: 600px/);
});
test("popup change retains n8n integration and cookie access", () => {
  assert.match(read("src/background.js"), /n8nService/);
  assert.ok(manifest.permissions.includes("cookies"));
  assert.ok(manifest.optional_permissions.includes("storage"));
});
