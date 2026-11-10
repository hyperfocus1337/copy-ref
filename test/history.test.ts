import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  displayTitle,
  historyQuery,
  listProfiles,
  loadHistory,
  markdownLink,
  matchHistory,
  parseDays,
} from "../src/history.ts";

const DAY = 86_400_000;
const now = Date.now();

// A Chromium History file with rows [url, title, visits, ms since 1970, hidden].
function makeHistory(dir: string, rows: [string, string, number, number, number][]) {
  mkdirSync(dir, { recursive: true });
  const values = rows
    .map(([url, title, visits, ms, hidden]) => {
      // Chromium time: microseconds since 1601, larger than a safe JS integer.
      const time = (BigInt(ms) + 11_644_473_600_000n) * 1000n;
      return `('${url}', '${title}', ${visits}, ${time}, ${hidden})`;
    })
    .join(", ");
  execFileSync("/usr/bin/sqlite3", [
    join(dir, "History"),
    "CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER," +
      ` last_visit_time INTEGER, hidden INTEGER); INSERT INTO urls (url, title, visit_count,` +
      ` last_visit_time, hidden) VALUES ${values};`,
  ]);
}

// Edge: two named profiles, one profile without History, one broken History.
// Brave: no Local State, so only Default.
const base = mkdtempSync(join(tmpdir(), "copy-ref-history-"));
const edge = join(base, "Microsoft Edge");
const brave = join(base, "BraveSoftware", "Brave-Browser");
makeHistory(join(edge, "Default"), [
  ["https://docs.example.com/a", "Example Docs", 3, now - 2 * DAY, 0],
  ["https://shared.example.com/", "", 1, now - 1 * DAY, 0],
  ["https://hidden.example.com/", "Hidden", 9, now - DAY, 1],
  ["https://old.example.com/", "Old Page", 5, now - 200 * DAY, 0],
]);
makeHistory(join(edge, "Profile 1"), [
  ["https://work.example.com/", "Work Tracker", 2, now - 3 * DAY, 0],
]);
mkdirSync(join(edge, "Profile 3"));
writeFileSync(join(edge, "Profile 3", "History"), "not a database");
writeFileSync(
  join(edge, "Local State"),
  JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: "Personal" },
        "Profile 1": { name: "Work" },
        "Profile 2": { name: "Empty" },
        "Profile 3": { name: "Broken" },
      },
    },
  }),
);
makeHistory(join(brave, "Default"), [
  ["https://shared.example.com/", "Shared [Page]", 4, now - 5 * DAY, 0],
]);

test("listProfiles reads Local State and keeps profiles with a History file", async () => {
  const names = (await listProfiles("edge", base)).map((p) => p.name).sort();
  assert.deepEqual(names, ["Broken", "Personal", "Work"]);
  assert.deepEqual(
    (await listProfiles("brave", base)).map((p) => p.name),
    ["Default"],
  );
});

test("loadHistory merges URLs over browsers and reports unreadable profiles", async () => {
  const { entries, failed } = await loadHistory(["edge", "brave"], 90, base);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^Microsoft Edge Broken: .*not a database/);
  assert.deepEqual(
    entries.map((e) => e.url),
    ["https://shared.example.com/", "https://docs.example.com/a", "https://work.example.com/"],
  );
  const shared = entries[0];
  // The latest visit has no title, so the older Brave title stays.
  assert.equal(shared.title, "Shared [Page]");
  assert.equal(shared.visits, 5);
  assert.ok(Math.abs(shared.last - (now - DAY)) < 2);
  assert.deepEqual(
    shared.sources.map((s) => `${s.browser}:${s.profile}`),
    ["edge:Personal", "brave:Default"],
  );
});

test("loadHistory with 0 days reads all history, and only the chosen browsers", async () => {
  const { entries } = await loadHistory(["edge"], 0, base);
  assert.ok(entries.some((e) => e.url === "https://old.example.com/"));
  assert.ok(entries.every((e) => e.sources.every((s) => s.browser === "edge")));
});

test("matchHistory needs every word in the title or URL", async () => {
  const { entries } = await loadHistory(["edge", "brave"], 90, base);
  assert.deepEqual(
    matchHistory(entries, "EXAMPLE docs", 10).map((e) => e.url),
    ["https://docs.example.com/a"],
  );
  assert.deepEqual(
    matchHistory(entries, "tracker work.example", 10).map((e) => e.url),
    ["https://work.example.com/"],
  );
  assert.equal(matchHistory(entries, "", 2).length, 2);
  assert.equal(matchHistory(entries, "nothing-matches", 10).length, 0);
});

test("historyQuery limits by days only when days is above 0", () => {
  assert.ok(historyQuery(30, 1_000 * DAY).endsWith(" > 83808000000"));
  assert.doesNotMatch(historyQuery(0), /last_visit_time \/ 1000 - \d+ >/);
});

test("parseDays, displayTitle and markdownLink", () => {
  assert.equal(parseDays(" 30 "), 30);
  assert.equal(parseDays("0"), 0);
  assert.equal(parseDays("-1"), undefined);
  assert.equal(parseDays("1.5"), undefined);
  assert.equal(parseDays(""), undefined);
  const visit = { url: "https://a.example.com/x", title: "", visits: 1, last: 0 };
  assert.equal(displayTitle(visit), "a.example.com");
  assert.equal(displayTitle({ ...visit, url: "not a url" }), "not a url");
  assert.equal(markdownLink({ ...visit, title: "A [b]" }), "[A \\[b\\]](https://a.example.com/x)");
});

test("an unreadable Local State fails that browser only, with the reason", async () => {
  const blocked = mkdtempSync(join(tmpdir(), "copy-ref-history-blocked-"));
  makeHistory(join(blocked, "Microsoft Edge", "Default"), [
    ["https://a.example.com/", "A", 1, now, 0],
  ]);
  makeHistory(join(blocked, "BraveSoftware", "Brave-Browser", "Default"), [
    ["https://b.example.com/", "B", 1, now, 0],
  ]);
  const state = join(blocked, "Microsoft Edge", "Local State");
  writeFileSync(state, "{}");
  chmodSync(state, 0o000);
  const { entries, failed } = await loadHistory(["edge", "brave"], 90, blocked);
  assert.deepEqual(
    entries.map((e) => e.url),
    ["https://b.example.com/"],
  );
  assert.equal(failed.length, 1);
  assert.match(failed[0], /^Microsoft Edge: EACCES/);
});
