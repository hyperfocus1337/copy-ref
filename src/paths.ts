import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createWriteStream,
  existsSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { once } from "node:events";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";

// Raycast starts extensions with a minimal PATH, without Homebrew.
const env = { ...process.env, PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin` };

export type Entry = { root: string; rel: string; path: string; isDir: boolean };

// exclude holds fd globs. A glob that starts with "/" matches only at the top of a root.
export type IndexOptions = { includeHidden: boolean; includeIgnored: boolean; exclude: string[] };

export type Exclusion = { pattern: string; on: boolean };

// What the index contains. Raycast LocalStorage keeps it under SETTINGS_KEY.
export type Settings = {
  roots: string[];
  includeHidden: boolean;
  includeIgnored: boolean;
  exclusions: Exclusion[];
  // The default patterns the settings know. Settings saved before this field know all of them.
  seenDefaults?: string[];
};

export const SETTINGS_KEY = "settings";

export const DEFAULT_EXCLUSIONS: Exclusion[] = [
  "/Library",
  "/OrbStack",
  "node_modules",
  ".pnpm-store",
  "bower_components",
  ".venv",
  ".venv-*",
  "venv",
  "vendor",
  ".git",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  "*.egg-info",
  "dist",
  "build",
  "target",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".wrangler",
  ".vercel",
  ".contentlayer",
  "coverage",
  ".cache",
  ".terraform",
  ".terragrunt-cache",
  "apm_modules",
  ".direnv",
  ".devenv",
  "eln-cache",
].map((pattern) => ({ pattern, on: true }));

export const DEFAULT_SETTINGS: Settings = {
  roots: ["~"],
  includeHidden: false,
  includeIgnored: false,
  exclusions: DEFAULT_EXCLUSIONS,
  seenDefaults: DEFAULT_EXCLUSIONS.map((item) => item.pattern),
};

// Adds, turned on, each default pattern that came after the settings were saved.
// A default the user deleted stays deleted, because seenDefaults still holds it.
export function withNewDefaults(settings: Settings): Settings {
  const defaults = DEFAULT_EXCLUSIONS.map((item) => item.pattern);
  const seen = settings.seenDefaults ?? defaults;
  const added = DEFAULT_EXCLUSIONS.filter(
    (item) =>
      !seen.includes(item.pattern) &&
      !settings.exclusions.some((other) => other.pattern === item.pattern),
  );
  return { ...settings, exclusions: [...settings.exclusions, ...added], seenDefaults: defaults };
}

export function indexOptions(settings: Settings): IndexOptions {
  return {
    includeHidden: settings.includeHidden,
    includeIgnored: settings.includeIgnored,
    exclude: settings.exclusions.filter((item) => item.on).map((item) => item.pattern),
  };
}

// The index entries a path list shows.
export type Kind = "all" | "file" | "folder";

export function isKind(entry: Entry, kind: Kind): boolean {
  return kind === "all" || entry.isDir === (kind === "folder");
}

export function expandTilde(path: string): string {
  return path === "~" || path.startsWith("~/") ? homedir() + path.slice(1) : path;
}

export function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

// A bind mount: host is a real path, container has no trailing slash.
export type Mount = { host: string; container: string };

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

// The mounts under /workspaces in the compose file, longest host path first, or [] when file
// is empty or missing.
// shortcut: a regexp and not a YAML parser. It reads only the short-form "- SRC:DEST[:FLAG]"
// volume lines. The upgrade is a YAML parser, for long-form volume entries.
export function readMounts(file: string): Mount[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const mounts = [...text.matchAll(/^[ \t]*- ([^:#\n]+):(\/workspaces\/[^:#\n]+)/gm)].map((m) => ({
    host: realPath(expandTilde(m[1].replace(/\$\{HOME\}|\$HOME\b/g, homedir()))),
    container: m[2].trim().replace(/\/+$/, ""),
  }));
  return mounts.sort((a, b) => b.host.length - a.host.length);
}

// The path of path inside the devcontainer, through the longest mount that holds it, or
// undefined. The mount ~/code:/workspaces/code gives /workspaces/code/app for ~/code/app.
export function devcontainerPath(path: string, mounts: Mount[]): string | undefined {
  const real = realPath(path);
  const mount = mounts.find(({ host }) => real === host || real.startsWith(`${host}/`));
  return mount && mount.container + real.slice(mount.host.length);
}

// What Shift+Return pastes. Raycast LocalStorage keeps the choice under PASTE_KEY.
export const PASTE_TITLES = {
  tilde: "Tilde Path",
  absolute: "Absolute Path",
  name: "Name",
  repo: "Path Relative to Repository",
  devcontainer: "Devcontainer Path",
};

export type PasteKind = keyof typeof PASTE_TITLES;

export const PASTE_KEY = "paste";

export const DEFAULT_PASTE: PasteKind = "tilde";

// The stored choice as a kind. "group" and "project" were the two devcontainer kinds before
// the paths came from the compose file.
export function toPasteKind(value: string | undefined): PasteKind {
  if (value === "group" || value === "project") return "devcontainer";
  return value !== undefined && value in PASTE_TITLES ? (value as PasteKind) : DEFAULT_PASTE;
}

// The text of kind for path, or undefined when path has none.
export function pasteText(path: string, kind: PasteKind, mounts: Mount[] = []): string | undefined {
  switch (kind) {
    case "tilde":
      return tildePath(path);
    case "absolute":
      return path;
    case "name":
      return basename(path);
    case "repo":
      return repoRelative(path);
    case "devcontainer":
      return devcontainerPath(path, mounts);
  }
}

// The root folders -> absolute paths without a trailing slash, each one once.
export function parseRoots(folders: (string | undefined)[]): string[] {
  const roots = folders
    .map((root) => root?.trim())
    .filter((root) => !!root)
    .map((root) => resolve(expandTilde(root!)));
  return [...new Set(roots)];
}

// An index line is "<root>\t<path relative to root>"; fd ends folder paths with "/".
export function parseLine(line: string): Entry {
  const tab = line.indexOf("\t");
  const root = line.slice(0, tab);
  const rel = line.slice(tab + 1);
  const isDir = rel.endsWith("/");
  return { root, rel, isDir, path: join(root, isDir ? rel.slice(0, -1) : rel) };
}

// path or the nearest folder above it that holds .git, or undefined. A file named .git
// marks a worktree.
function repoRoot(path: string): string | undefined {
  for (let dir = path; dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
  }
}

// The path relative to the nearest git repository that contains it, "." for the
// repository folder, or undefined.
export function repoRelative(path: string): string | undefined {
  const root = repoRoot(path);
  return root && (relative(root, path) || ".");
}

// The name of the nearest git repository that contains path, or undefined.
export function repoName(path: string): string | undefined {
  const root = repoRoot(path);
  return root && basename(root);
}

// The output of a command without its last newline. Throws message when it fails.
function run(command: string, args: string[], message: string): string {
  try {
    return execFileSync(command, args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trimEnd();
  } catch {
    throw new Error(message);
  }
}

// The host name that ssh connects to for alias, from ~/.ssh/config: work.gitlab.com
// gives gitlab.com.
function sshHost(alias: string): string {
  try {
    return /^hostname (.+)$/m.exec(run("/usr/bin/ssh", ["-G", alias], ""))?.[1] ?? alias;
  } catch {
    return alias;
  }
}

// The web homepage of a git remote URL in the https, ssh:// or scp (git@host:owner/repo)
// form, or undefined. host maps the SSH host of the URL to its real name.
export function remoteHomepage(url: string, host: (alias: string) => string): string | undefined {
  const web = /^(https?):\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  if (web) return `${web[1]}://${web[2]}/${web[3]}`;
  const ssh = /^(?:ssh:\/\/)?(?:[^@/]+@)?([^:/]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(url);
  return ssh ? `https://${host(ssh[1])}/${ssh[2]}` : undefined;
}

// The link to rel at ref on the forge of homepage, as git-link makes it: /tree/ for a
// folder, /blob/ for a file, and the GitLab /-/ prefix on each host but github.com.
// shortcut: Gitea and Bitbucket hosts get a GitLab link. Upgrade: a host to forge map
// in the settings.
export function forgeLink(homepage: string, ref: string, rel: string, isDir: boolean): string {
  const prefix = new URL(homepage).hostname === "github.com" ? "" : "/-";
  const path = rel.split("/").map(encodeURIComponent).join("/");
  return `${homepage}${prefix}/${isDir ? "tree" : "blob"}/${ref}${rel ? `/${path}` : ""}`;
}

function gitRoot(path: string): string {
  const root = repoRoot(path);
  if (root === undefined) throw new Error("Not inside a git repository");
  return root;
}

// The homepage of the origin remote of the repository that holds path. Throws the reason
// when there is none.
export function gitHomepage(path: string): string {
  const root = gitRoot(path);
  const url = run("git", ["-C", root, "remote", "get-url", "origin"], "No origin remote");
  const homepage = remoteHomepage(url, sshHost);
  if (homepage === undefined) throw new Error(`Cannot read the remote URL ${url}`);
  return homepage;
}

// The link to path on the forge at the current branch, or at the HEAD commit when pinned.
// Throws the reason when there is none.
export function gitLink(path: string, isDir: boolean, pinned: boolean): string {
  const root = gitRoot(path);
  const ref = pinned
    ? run("git", ["-C", root, "rev-parse", "HEAD"], "The repository has no commit")
    : run("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], "HEAD is detached");
  return forgeLink(gitHomepage(path), ref, relative(root, path), isDir);
}

export const FILE_LIMIT = 1_000_000;

// The text of the file at path. Throws on a folder, on a file over FILE_LIMIT bytes, and
// on a binary file: one with a NUL byte in its first 8000 bytes, the test of git.
export function fileText(path: string): string {
  const stat = statSync(path);
  if (stat.isDirectory()) throw new Error("A folder has no contents");
  if (stat.size > FILE_LIMIT) throw new Error(`The file is over ${FILE_LIMIT / 1e6} MB`);
  const data = readFileSync(path);
  if (data.subarray(0, 8000).includes(0)) throw new Error("The file is binary");
  return data.toString("utf8");
}

// Runs a command and passes each output line to onLine. When onLine returns false, stops the command.
async function eachLine(
  command: string,
  args: string[],
  stdin: number | "ignore",
  okCodes: number[],
  onLine: (line: string) => boolean | Promise<void>,
): Promise<void> {
  const child = spawn(command, args, { env, stdio: [stdin, "pipe", "pipe"] });
  const exit = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  // Awaited below. This handler only stops an unhandled rejection while the lines are read.
  exit.catch(() => undefined);
  let stderr = "";
  // stdio pipes stdout and stderr, so both streams exist.
  child.stderr!.on("data", (data) => (stderr += data));
  for await (const line of createInterface({ input: child.stdout! })) {
    if ((await onLine(line)) === false) {
      child.kill();
      break;
    }
  }
  const code = await exit;
  if (!child.killed && !okCodes.includes(code ?? -1)) {
    throw new Error(stderr.trim() || `${command} exited with code ${code}`);
  }
}

// Writes all files and folders under the roots to file. Replaces file only when every root succeeds.
export async function buildIndex(
  roots: string[],
  options: IndexOptions,
  file: string,
): Promise<void> {
  const flags = ["--color=never"];
  if (options.includeHidden) flags.push("--hidden");
  if (options.includeIgnored) flags.push("--no-ignore");
  // An exclude glob applies also when the ignore files are off.
  for (const pattern of options.exclude) flags.push("--exclude", pattern);

  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  const out = createWriteStream(tmp);
  try {
    for (const root of roots) {
      await eachLine(
        "fd",
        [...flags, "--base-directory", root, "."],
        "ignore",
        [0],
        async (line) => {
          if (!out.write(`${root}\t${line}\n`)) await once(out, "drain");
        },
      );
    }
    out.end();
    await finished(out);
    await rename(tmp, file);
  } catch (error) {
    out.destroy();
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}

// The best fzf matches for query in the index, matched against the path relative to its root.
export async function search(
  file: string,
  query: string,
  limit: number,
  kind: Kind = "all",
): Promise<Entry[]> {
  // Folder paths end with "/": the fzf term "/$" keeps only folders, "!/$" only files.
  const filter = kind === "folder" ? `${query} /$` : kind === "file" ? `${query} !/$` : query;
  const entries: Entry[] = [];
  const stdin = openSync(file, "r");
  try {
    // fzf exits with 1 when nothing matches.
    const args = ["--filter", filter, "--scheme", "path", "--delimiter", "\t", "--nth", "2.."];
    await eachLine("fzf", args, stdin, [0, 1], (line) => {
      entries.push(parseLine(line));
      return entries.length < limit;
    });
  } finally {
    closeSync(stdin);
  }
  return entries;
}
