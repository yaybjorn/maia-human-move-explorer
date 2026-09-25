import { chromium } from "/Users/odin/.openclaw/workspace/repos/apps/kabal/node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const courseID = "10000000-0000-4000-8000-000000000001";
const documentFixture = { schemaVersion: 1, sourcePGN: "", metadata: { title: "Fixture course", slug: "fixture-course", side: "white", access: "free" }, headers: {}, nodes: [] };
await page.route("**/studio/api/**", async route => {
  const url = new URL(route.request().url());
  const respond = value => route.fulfill({ contentType: "application/json", body: JSON.stringify(value) });
  const path = url.pathname.replace("/studio/api", "");
  if (path === "/session") return respond({ user: { id: "fixture", name: "Fixture author", email: "fixture@example.test" }, csrfToken: "fixture-csrf" });
  if (path === "/courses") return respond({ courses: [{ id: courseID, title: "Fixture course", slug: "fixture-course", draftRevision: 1 }] });
  if (path === "/effects") return respond({ effects: [] });
  if (path === "/ignored-words") return respond({ words: [] });
  if (path === `/courses/${courseID}`) return respond({ course: { id: courseID, title: "Fixture course", slug: "fixture-course" }, draft: { revision: 1, document: documentFixture } });
  if (path === `/courses/${courseID}/user-games`) return respond({ submissions: [{ id: "20000000-0000-4000-8000-000000000001", provider: "lichess", gameID: "AbCdEf12", gameURL: "https://lichess.org/AbCdEf12", submittedAt: "2026-09-25T20:00:00Z", message: "<strong>Safe text</strong>" }], nextCursor: "20000000-0000-4000-8000-000000000001" });
  return respond({});
});
await page.goto("http://127.0.0.1:8311/studio");
await page.getByRole("button", { name: /open fixture course/i }).click();
await page.getByRole("button", { name: "User games" }).click();
await page.getByRole("link", { name: "Open on Lichess" }).waitFor();
const result = {
  active: await page.locator('[data-panel="user-games"].active').count(),
  link: await page.getByRole("link", { name: "Open on Lichess" }).getAttribute("href"),
  rel: await page.getByRole("link", { name: "Open on Lichess" }).getAttribute("rel"),
  target: await page.getByRole("link", { name: "Open on Lichess" }).getAttribute("target"),
  messageText: await page.locator(".user-game-message").textContent(),
  messageMarkup: await page.locator(".user-game-message").innerHTML(),
  loadMoreVisible: await page.getByRole("button", { name: "Load more" }).isVisible(),
};
console.log(JSON.stringify(result));
await page.screenshot({ path: new URL("fixture-desktop.png", import.meta.url).pathname, fullPage: true });
await browser.close();
