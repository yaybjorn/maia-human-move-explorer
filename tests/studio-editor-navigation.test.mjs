import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const html = readFileSync(new URL("../app/static/studio.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../app/static/studio.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../app/static/studio.css", import.meta.url), "utf8");

test("editor forward navigation uses an explicit continuation chooser", () => {
  assert.match(html, /id="editor-choice"/);
  assert.match(html, /id="editor-choice-options"/);
  assert.match(source, /function advanceEditor\(initiator\)/);
  assert.match(source, /function advanceEditor\(initiator\) \{\n  flushActiveEditor\(\);/);
  assert.match(source, /const options = childrenOf\(state\.document, state\.currentNodeID\);\n  if \(options\.length < 2\) \{ if \(options\[0\]\) navigate\(options\[0\]\.id\); return; \}/);
  assert.match(source, /function confirmEditorChoice\(\)/);
  assert.match(source, /closeChoice\(\{restoreFocus:true\}\)/);
  assert.match(source, /\$\("go-forward"\)\.addEventListener\("click",event=>advanceEditor\(event\.currentTarget\)\)/);
});

test("editor chooser preserves text editing and scrolls only its move tree", () => {
  assert.match(source, /function scrollEditorCurrentIntoView\(\)/);
  assert.match(source, /const tree = \$\("move-tree"\), current = tree\.querySelector\("\.move-chip\.current"\)/);
  assert.match(source, /else if \(state\.view === "editor"\) requestAnimationFrame\(scrollEditorCurrentIntoView\)/);
  assert.match(source, /!editing&&\["editor","recording"\]\.includes\(state\.view\)/);
  assert.match(source, /else advanceEditor\(\$\("go-forward"\)\)/);
  assert.match(css, /\.editor-tree-stage\{position:relative\}/);
  assert.match(css, /\.editor-choice\{position:absolute/);
});
