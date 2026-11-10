import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type Browser = "edge" | "brave";

// dir is the data folder under ~/Library/Application Support.
export const BROWSERS: Record<Browser, { title: string; app: string; dir: string }> = {
  edge: { title: "Microsoft Edge", app: "Microsoft Edge", dir: "Microsoft Edge" },
  brave: { title: "Brave", app: "Brave Browser", dir: "BraveSoftware/Brave-Browser" },
};

export const APP_SUPPORT = join(homedir(), "Library", "Application Support");

// dir is the absolute profile folder; name is the name the browser shows.
export type Profile = { browser: Browser; dir: string; name: string };

// last is the time of the latest visit, in milliseconds since 1970.
export type Visit = { url: string; title: string; visits: number; last: number };

export type Source = { browser: Browser; profile: string; last: number };

// One row per URL. text is the lowercase title and URL that a search matches.
export type HistoryEntry = Visit & { sources: Source[]; text: string };

// The profiles of browser that have a History file. "Local State" names them;
// without it, only the Default profile is read. Another read error, such as a
// macOS privacy block, throws.
export async function listProfiles(browser: Browser, base = APP_SUPPORT): Promise<Profile[]> {
  const root = join(base, BROWSERS[browser].dir);
  let cache: Record<string, { name?: string }> = { Default: { name: "Default" } };
  try {
    const state = JSON.parse(await readFile(join(root, "Local State"), "utf8"));
    cache = state?.profile?.info_cache ?? cache;
  } catch (error) {
    // A browser that never ran has no Local State.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return Object.entries(cache)
    .map(([dir, info]) => ({ browser, dir: join(root, dir), name: info.name || dir }))
    .filter((profile) => existsSync(join(profile.dir, "History")));
}

// Chromium keeps times in microseconds since 1601. The conversion runs in SQL,
// because these values are larger than Number.MAX_SAFE_INTEGER.
const EPOCH_GAP_MS = 11_644_473_600_000;

// The query for the visible URLs visited in the last days; days 0 means all.
export function historyQuery(days: number, now = Date.now()): string {
  const last = `last_visit_time / 1000 - ${EPOCH_GAP_MS}`;
  const since = days > 0 ? ` AND ${last} > ${now - days * 86_400_000}` : "";
  return (
    `SELECT url, title, visit_count AS visits, ${last} AS last FROM urls` +
    ` WHERE hidden = 0 AND last_visit_time > 0${since}`
  );
}

// The visits of one profile. immutable=1 reads the file while the browser
// holds its lock, without a copy; visits of the last seconds can be missing.
export async function readProfile(profile: Profile, days: number): Promise<Visit[]> {
  const uri = `file:${encodeURI(join(profile.dir, "History"))}?immutable=1`;
  const { stdout } = await run(
    "/usr/bin/sqlite3",
    ["-readonly", "-json", uri, historyQuery(days)],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  // sqlite3 prints nothing when no row matches.
  return stdout.trim() === "" ? [] : (JSON.parse(stdout) as Visit[]);
}

// One entry per URL, the latest visit first. The title comes from the latest
// visit that has one; the visit counts of all profiles add up.
export function mergeVisits(read: { profile: Profile; visits: Visit[] }[]): HistoryEntry[] {
  const byUrl = new Map<string, HistoryEntry>();
  for (const { profile, visits } of read) {
    for (const visit of visits) {
      const source = { browser: profile.browser, profile: profile.name, last: visit.last };
      const entry = byUrl.get(visit.url);
      if (entry === undefined) {
        byUrl.set(visit.url, { ...visit, title: visit.title ?? "", sources: [source], text: "" });
        continue;
      }
      if (visit.title && (visit.last > entry.last || entry.title === "")) entry.title = visit.title;
      entry.last = Math.max(entry.last, visit.last);
      entry.visits += visit.visits;
      entry.sources.push(source);
    }
  }
  const entries = [...byUrl.values()];
  for (const entry of entries) {
    entry.text = `${entry.title} ${entry.url}`.toLowerCase();
    entry.sources.sort((a, b) => b.last - a.last);
  }
  return entries.sort((a, b) => b.last - a.last || b.visits - a.visits);
}

// The first limit entries whose title or URL holds each word of query.
export function matchHistory(
  entries: HistoryEntry[],
  query: string,
  limit: number,
): HistoryEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found: HistoryEntry[] = [];
  for (const entry of entries) {
    if (words.every((word) => entry.text.includes(word))) found.push(entry);
    if (found.length === limit) break;
  }
  return found;
}

// The reason of a failed read: the sqlite3 error output, or the error message.
function reason(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim();
  return stderr || (error instanceof Error ? error.message : String(error));
}

// The merged history of the browsers, and a "<what>: <reason>" line for each
// browser or profile that could not be read. The others still show.
export async function loadHistory(
  browsers: Browser[],
  days: number,
  base = APP_SUPPORT,
): Promise<{ entries: HistoryEntry[]; failed: string[] }> {
  const failed: string[] = [];
  const profiles: Profile[] = [];
  const listed = await Promise.allSettled(browsers.map((b) => listProfiles(b, base)));
  listed.forEach((result, i) => {
    if (result.status === "fulfilled") profiles.push(...result.value);
    else failed.push(`${BROWSERS[browsers[i]].title}: ${reason(result.reason)}`);
  });
  const results = await Promise.allSettled(profiles.map((p) => readProfile(p, days)));
  const read: { profile: Profile; visits: Visit[] }[] = [];
  results.forEach((result, i) => {
    const profile = profiles[i];
    if (result.status === "fulfilled") read.push({ profile, visits: result.value });
    else
      failed.push(`${BROWSERS[profile.browser].title} ${profile.name}: ${reason(result.reason)}`);
  });
  return { entries: mergeVisits(read), failed };
}

// The days of the History Days preference: a whole number, 0 for all history.
export function parseDays(text: string): number | undefined {
  return /^\s*\d+\s*$/.test(text) ? Number(text) : undefined;
}

// The title, or the host of a URL without one.
export function displayTitle(entry: Visit): string {
  if (entry.title) return entry.title;
  try {
    return new URL(entry.url).host || entry.url;
  } catch {
    return entry.url;
  }
}

export function markdownLink(entry: Visit): string {
  return `[${displayTitle(entry).replace(/[[\]]/g, "\\$&")}](${entry.url})`;
}
