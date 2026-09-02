import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../app/static/studio.html", import.meta.url), "utf8");

test("places collapsible Maia beneath the selected move inspector", () => {
  const inspector = html.indexOf('id="move-inspector"');
  const maia = html.indexOf('id="editor-maia-card"');
  const rawPGN = html.indexOf('id="raw-pgn"');
  assert.ok(inspector >= 0 && maia > inspector && rawPGN > maia);
  assert.match(html, /data-editor-panel-toggle="tree"/);
  assert.match(html, /data-editor-panel-toggle="maia"[^>]+aria-expanded="false"/);
});

test("removes the analysis page and moves coverage into Quality checks", () => {
  assert.doesNotMatch(html, /data-panel="analysis"/);
  assert.doesNotMatch(html, /data-view="analysis"/);
  const quality = html.indexOf('data-panel="quality"');
  const coverage = html.indexOf("Whole-course coverage");
  assert.ok(quality >= 0 && coverage > quality);
});

test("offers a desktop icon-only sidebar mode", () => {
  assert.match(html, /id="toggle-sidebar"/);
  assert.match(html, /class="nav-text">Repertoire editor</);
});
