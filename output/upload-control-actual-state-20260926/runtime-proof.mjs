import { chromium } from "/opt/homebrew/lib/node_modules/openclaw/node_modules/playwright-core/index.mjs";
import fs from "node:fs/promises";

const out = new URL(".", import.meta.url).pathname;
const result = { checks: {}, calls: [], failures: [], screenshot: "blocked-upload-control.png" };
const browser = await chromium.connectOverCDP("http://127.0.0.1:18800");
const page = await browser.contexts()[0].newPage();

try {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`https://ggm.fablelabs.no/?upload-control-runtime=${Date.now()}`, { waitUntil: "networkidle" });
  result.checks.module = await page.evaluate(async () => {
    const source = await (await fetch("/static/studio.js?v=20260923-chapters", { cache: "no-store" })).text();
    return source.includes("studio-upload-panel.mjs?v=20260926-upload-recovery-control");
  });
  await page.evaluate(async target => {
    const original = document.querySelector("#staged-upload-panel");
    const root = original.cloneNode(true);
    root.id = "runtime-upload-control-proof";
    root.hidden = false;
    document.querySelector('[data-panel="chapter-video"]').append(root);
    const { createUploadPanel } = await import("/static/studio-upload-panel.mjs?v=20260926-upload-recovery-control");
    const record = {
      schema: 1, actorID: "d10ceeba-1b99-4b64-8195-0567c892a98b", courseID: target.courseID,
      chapterID: "runtime-proof-chapter", draftRevision: 1, uploadID: target.uploadID,
      title: "Existing chapter video", state: "blocked",
      files: { video: { byteLength: 1, mimeType: "video/mp4", parts: [{ partNumber: 1, offset: 0, byteLength: 1, sha256: "00" }] }, thumbnail: { byteLength: 1, mimeType: "image/png", parts: [{ partNumber: 1, offset: 0, byteLength: 1, sha256: "00" }] } },
    };
    const storage = new Map();
    const key = `gingergm-staged-upload-v1:${record.actorID}:${record.courseID}:chapter:${record.chapterID}`;
    storage.set(key, JSON.stringify(record));
    window.__uploadControlProof = { calls: [] };
    const api = { request: async (path, options = {}) => {
      window.__uploadControlProof.calls.push({ path, method: options.method || "GET" });
      return { uploadID: record.uploadID, draftRevision: record.draftRevision, title: record.title, revision: 1, blocked: true,
        files: { video: { byteLength: 1, offset: 0, parts: [], stored: false }, thumbnail: { byteLength: 1, offset: 0, parts: [], stored: false } } };
    } };
    const panel = createUploadPanel({ root, api, storage: { getItem: value => storage.get(value) || null, setItem: (value, data) => storage.set(value, data), removeItem: value => storage.delete(value) }, getContext: () => ({ actorID: record.actorID, courseID: record.courseID, chapterID: record.chapterID, revision: 1, dirty: false, metadata: {}, chapterTitle: record.title }) });
    panel.refresh();
  }, { uploadID: "115fc033-e942-43b8-af31-8c0397fc6c6f", courseID: "8547fdae-9d9f-40c7-af48-6e4111c47551" });
  const control = page.locator("#runtime-upload-control-proof [data-upload=check]");
  result.checks.beforeClick = await control.evaluate(button => ({ hidden: button.hidden, disabled: button.disabled, text: button.textContent, rect: button.getBoundingClientRect().toJSON(), display: getComputedStyle(button).display, visibility: getComputedStyle(button).visibility }));
  await control.click();
  await page.waitForTimeout(20);
  result.calls = await page.evaluate(() => window.__uploadControlProof.calls);
  result.checks.afterClick = await control.evaluate(button => ({ hidden: button.hidden, disabled: button.disabled, text: button.textContent, rect: button.getBoundingClientRect().toJSON(), display: getComputedStyle(button).display, visibility: getComputedStyle(button).visibility }));
  result.checks.status = await page.locator("#runtime-upload-control-proof [data-upload=status]").textContent();
  if (!result.checks.module || result.checks.beforeClick.hidden || result.checks.beforeClick.disabled || result.checks.beforeClick.rect.width <= 0 || result.checks.beforeClick.rect.height <= 0 || result.checks.beforeClick.display === "none" || result.checks.beforeClick.visibility !== "visible" || result.checks.status !== "Upload needs attention: an operation is uncertain or expired. No operation will be repeated." || JSON.stringify(result.calls) !== JSON.stringify([{ path: "/courses/8547fdae-9d9f-40c7-af48-6e4111c47551/offline-video/uploads/115fc033-e942-43b8-af31-8c0397fc6c6f/operations", method: "GET" }])) throw new Error(JSON.stringify(result));
  await page.screenshot({ path: `${out}/${result.screenshot}`, fullPage: false });
} catch (error) {
  result.failures.push(String(error));
} finally {
  await page.close();
  await browser.close();
}

await fs.writeFile(`${out}/runtime-proof.json`, JSON.stringify(result, null, 2));
if (result.failures.length) process.exitCode = 1;
