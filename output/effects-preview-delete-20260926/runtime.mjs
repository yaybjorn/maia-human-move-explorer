import { chromium } from "/Users/odin/.openclaw/workspace/repos/apps/kabal/node_modules/playwright/index.mjs";
import fs from "node:fs";

const out = new URL(".", import.meta.url).pathname;
const fixturePath = "/Users/odin/.openclaw/workspace/repos/web/maia-human-move-explorer/output/effects-library-20260925/transparent-white-figure.webm";
const course = { schemaVersion: 1, metadata: { title: "Effects delete fixture", slug: "effects-delete-fixture", side: "white" }, sourcePGN: "1. e4 e5 *", nodes: [{ id: "1", parentId: null, uci: "e2e4", san: "e4", ply: 1 }], headers: {}, chapters: [], chapterDrafts: [] };
const result = { previews: {}, cancel: null, confirm: null, failures: [], screenshots: [] };
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", error => result.failures.push(`page error: ${error}`));
page.on("console", message => { if (message.type() === "error") result.failures.push(`console: ${message.text()}`); });

try {
  await page.route("**/studio/api/**", async route => {
    const path = new URL(route.request().url()).pathname.replace("/studio/api", "");
    if (path === "/effects" || /^\/effects\/(?:[a-f0-9-]+|builtin-(?:explosion|viking|pipe))(?:\/media)?$/.test(path)) return route.continue();
    if (path === "/session") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ authenticated: true, csrfToken: "runtime-csrf", user: { id: "qa", roles: ["superadmin"] } }) });
    if (path === "/courses") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ courses: [{ id: "effects-delete-fixture", title: course.metadata.title, slug: course.metadata.slug, draftRevision: 1, positionCount: 2, chapterCount: 1 }] }) });
    if (path === "/courses/effects-delete-fixture") return route.fulfill({ contentType: "application/json", body: JSON.stringify({ course: { id: "effects-delete-fixture", title: course.metadata.title, slug: course.metadata.slug }, draft: { revision: 1, document: course } }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({}) });
  });
  await page.goto("http://127.0.0.1:8934/studio", { waitUntil: "networkidle" });
  await page.locator('.nav-item[data-view="effects"]').click();
  await page.locator('#effects-list > article[data-effect-id="builtin-explosion"]').waitFor({ state: "visible" });
  for (const name of ["Explosion", "Viking"]) {
    const preview = page.locator(`[data-effect-id="builtin-${name.toLowerCase()}"] img`);
    await preview.waitFor();
    result.previews[name] = await preview.evaluate(image => ({ tag: image.tagName, naturalWidth: image.naturalWidth, visible: Boolean(image.getClientRects().length) }));
    if (result.previews[name].tag !== "IMG" || !result.previews[name].naturalWidth || !result.previews[name].visible) throw new Error(`${name} preview was not visibly decoded`);
  }
  const pipe = page.locator('[data-effect-id="builtin-pipe"] video');
  await pipe.evaluate(video => new Promise((resolve, reject) => { video.addEventListener("loadeddata", resolve, { once: true }); video.addEventListener("error", () => reject(Error("Pipe failed to decode")), { once: true }); video.load(); }));
  result.previews.Pipe = await pipe.evaluate(video => ({ tag: video.tagName, width: video.videoWidth, readyState: video.readyState, visible: Boolean(video.getClientRects().length) }));
  if (result.previews.Pipe.tag !== "VIDEO" || !result.previews.Pipe.width || result.previews.Pipe.readyState < 2 || !result.previews.Pipe.visible) throw new Error("Pipe preview was not visibly decoded");
  await page.screenshot({ path: `${out}/effects-previews.png`, fullPage: false }); result.screenshots.push("effects-previews.png");

  await page.locator('[data-effect-id="builtin-viking"] [data-effect-delete]').click();
  await page.getByRole("button", { name: "Cancel" }).last().click();
  result.cancel = { dialogOpen: await page.locator('#delete-effect-dialog[open]').count(), stillListed: await page.locator('#effects-list > article[data-effect-id="builtin-viking"]').count() };
  if (result.cancel.dialogOpen || result.cancel.stillListed !== 1) throw new Error(`cancel mutated effect: ${JSON.stringify(result.cancel)}`);

  await page.locator("#effect-name").fill("QA disposable effect");
  await page.locator("#effect-file").setInputFiles(fixturePath);
  await page.locator("#effect-save").click();
  const row = page.locator('#effects-list > article[data-effect-id]:has-text("QA disposable effect")');
  await row.waitFor(); const id = await row.getAttribute("data-effect-id");
  await row.locator("[data-effect-delete]").click();
  await page.getByRole("button", { name: "Delete effect" }).click();
  await row.waitFor({ state: "detached" });
  await page.reload({ waitUntil: "networkidle" }); await page.locator('.nav-item[data-view="effects"]').click();
  // The disposable host has no course document, so the Recording navigation
  // is correctly hidden.  Its picker is refreshed by loadEffects regardless;
  // inspect it directly after the reload.
  const recordingValues = await page.locator("#recording-effects option").evaluateAll(options => options.map(option => option.value));
  result.confirm = { id, effectsAbsent: await page.locator(`[data-effect-id="${id}"]`).count() === 0, recordingAbsent: !recordingValues.includes(`library:${id}`), builtinsIntact: await page.locator('[data-effect-id^="builtin-"]').count() === 3 };
  if (!result.confirm.effectsAbsent || !result.confirm.recordingAbsent || !result.confirm.builtinsIntact) throw new Error(`fixture deletion did not persist consistently: ${JSON.stringify(result.confirm)}`);
} catch (error) { result.failures.push(String(error)); }
await browser.close();
fs.writeFileSync(`${out}/runtime-result.json`, JSON.stringify(result, null, 2));
if (result.failures.length) process.exitCode = 1;
