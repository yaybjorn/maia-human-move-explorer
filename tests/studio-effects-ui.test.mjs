import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../app/static/studio.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../app/static/studio.js", import.meta.url), "utf8");

test("effects thumbnails use an image element for animated WebP sources", () => {
  assert.match(source, /\/\\\.webp\(\?:\[\?#\]\|\$\)\/i\.test\(item\.url\)/);
  assert.match(source, /<img src="\$\{escapeHTML\(item\.url\)\}" alt="">/);
});

test("effect deletion has a modal confirmation and only its delete submit calls the API", () => {
  assert.match(html, /id="delete-effect-dialog"/);
  assert.match(html, /value="cancel"[^>]*>Cancel/);
  assert.match(html, /value="delete"[^>]*>Delete effect/);
  assert.match(source, /function openEffectDeleteDialog\(item\)/);
  assert.match(source, /event\.submitter\?\.value !== "delete"\) return/);
  assert.match(source, /await api\.deleteEffect\(id\); dialog\.close\(\);/);
  assert.doesNotMatch(source, /Reset this built-in effect/);
});
