import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_PASTE,
  DEFAULT_SETTINGS,
  type IndexOptions,
  type Kind,
  PASTE_TITLES,
  buildIndex,
  FILE_LIMIT,
  devcontainerPath,
  fileText,
  forgeLink,
  indexOptions,
  isKind,
  parseRoots,
  pasteText,
  readMounts,
  remoteHomepage,
  repoName,
  repoRelative,
  search,
  tildePath,
  toPasteKind,
  withNewDefaults,
} from "../src/paths.ts";

// Two roots; repo has a gitignored file, a hidden folder, and .git internals.
const base = mkdtempSync(join(tmpdir(), "copy-ref-test-"));
const one = join(base, "one");
const two = join(base, "two");
for (const dir of [
  join(one, "repo", ".git"),
  join(one, "repo", ".github"),
  join(one, "repo", "src"),
  two,
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(one, "repo", ".git", "HEAD"), "");
writeFileSync(join(one, "repo", ".gitignore"), "build.log\n");
writeFileSync(join(one, "repo", "build.log"), "");
writeFileSync(join(one, "repo", ".github", "ci.yml"), "");
writeFileSync(join(one, "repo", "src", "main.ts"), "");
writeFileSync(join(two, "notes.md"), "");
// A third root for exclusions: Library at the top and inside a repo, and node_modules.
const three = join(base, "three");
for (const dir of ["Library", "repo/Library", "repo/node_modules"]) {
  mkdirSync(join(three, dir), { recursive: true });
}

const index = join(base, "support", "index.tsv");
const indexed = (options: Partial<IndexOptions>, roots = [one, two]) =>
  buildIndex(
    roots,
    { includeHidden: false, includeIgnored: false, exclude: [], ...options },
    index,
  ).then(() => readFileSync(index, "utf8").trim().split("\n").sort());

test("tilde and root paths", () => {
  assert.equal(tildePath(join(homedir(), "Repositories")), "~/Repositories");
  assert.equal(tildePath("/opt/x"), "/opt/x");
  assert.deepEqual(parseRoots([" ~/Repositories/", undefined, "", "/tmp", "/tmp/"]), [
    join(homedir(), "Repositories"),
    "/tmp",
  ]);
});

test("devcontainer paths from the compose mounts", () => {
  const compose = join(base, "compose.yml");
  writeFileSync(
    compose,
    [
      "services:",
      "  sandbox:",
      "    volumes:",
      `      # - ${one}:/workspaces/comment`,
      `      - ${one}:/workspaces/groups/one:delegated`,
      `      - ${one}/repo/src:/workspaces/projects/src  # mounted`,
      `      - ${two}:/home/user/two:ro`,
      "      - ${HOME}/nowhere:/workspaces/projects/home",
      "",
    ].join("\n"),
  );
  const mounts = readMounts(compose);
  // Only the /workspaces mounts, longest host path first.
  assert.deepEqual(mounts.map((m) => m.container).sort(), [
    "/workspaces/groups/one",
    "/workspaces/projects/home",
    "/workspaces/projects/src",
  ]);
  assert.ok(mounts.every((m, i) => i === 0 || mounts[i - 1].host.length >= m.host.length));
  assert.ok(mounts.some((m) => m.host === join(homedir(), "nowhere")));
  assert.equal(devcontainerPath(one, mounts), "/workspaces/groups/one");
  assert.equal(
    devcontainerPath(join(one, "repo", ".gitignore"), mounts),
    "/workspaces/groups/one/repo/.gitignore",
  );
  // The longest mount wins.
  assert.equal(
    devcontainerPath(join(one, "repo", "src", "main.ts"), mounts),
    "/workspaces/projects/src/main.ts",
  );
  // A sibling whose name starts with the mount name is not inside it.
  assert.equal(devcontainerPath(`${one}-old/x`, mounts), undefined);
  assert.equal(devcontainerPath(join(two, "notes.md"), mounts), undefined);
  assert.deepEqual(readMounts(join(base, "missing.yml")), []);
});

test("shift-return paste text", () => {
  assert.ok(DEFAULT_PASTE in PASTE_TITLES);
  const path = join(homedir(), "Repositories", "agents", "coding-agent-config");
  assert.equal(pasteText(path, "tilde"), "~/Repositories/agents/coding-agent-config");
  assert.equal(pasteText(path, "absolute"), path);
  assert.equal(pasteText(path, "name"), "coding-agent-config");
  assert.equal(pasteText("/opt/x", "devcontainer"), undefined);
  assert.equal(pasteText(join(one, "repo", "src", "main.ts"), "repo"), "src/main.ts");
  assert.equal(toPasteKind("group"), "devcontainer");
  assert.equal(toPasteKind("project"), "devcontainer");
  assert.equal(toPasteKind("name"), "name");
  assert.equal(toPasteKind("gone"), DEFAULT_PASTE);
  assert.equal(toPasteKind(undefined), DEFAULT_PASTE);
});

test("index without hidden and ignored files", async () => {
  assert.deepEqual(await indexed({}), [
    `${one}\trepo/`,
    `${one}\trepo/src/`,
    `${one}\trepo/src/main.ts`,
    `${two}\tnotes.md`,
  ]);
});

test("index with hidden files and .git excluded", async () => {
  const lines = await indexed({ includeHidden: true, exclude: [".git"] });
  assert.ok(lines.includes(`${one}\trepo/.github/ci.yml`));
  assert.ok(!lines.some((line) => line.includes(".git/")));
  assert.ok(!lines.some((line) => line.includes("build.log")));
});

test("index with everything", async () => {
  const lines = await indexed({ includeHidden: true, includeIgnored: true });
  assert.ok(lines.includes(`${one}\trepo/.git/HEAD`));
  assert.ok(lines.includes(`${one}\trepo/build.log`));
});

test("a missing root fails and keeps the old index", async () => {
  await indexed({});
  await assert.rejects(
    buildIndex(
      [join(base, "missing")],
      { includeHidden: false, includeIgnored: false, exclude: [] },
      index,
    ),
  );
  assert.ok(readFileSync(index, "utf8").includes("main.ts"));
});

// macOS gives fd the same error for a folder that Raycast has no access to.
test("an unreadable folder is skipped, and the index still builds", async () => {
  const root = join(base, "locked");
  mkdirSync(join(root, "secret"), { recursive: true });
  writeFileSync(join(root, "secret", "b.txt"), "");
  writeFileSync(join(root, "a.txt"), "");
  chmodSync(join(root, "secret"), 0o000);
  try {
    assert.deepEqual(await indexed({}, [root]), [`${root}\ta.txt`, `${root}\tsecret/`]);
  } finally {
    chmodSync(join(root, "secret"), 0o755);
  }
});

test("exclusions: /name only at the top of a root, name at any depth", async () => {
  assert.deepEqual(await indexed({ exclude: ["/Library", "node_modules"] }, [three]), [
    `${three}\trepo/`,
    `${three}\trepo/Library/`,
  ]);
});

test("default settings exclude only the patterns that are on", () => {
  const { exclude } = indexOptions(DEFAULT_SETTINGS);
  for (const pattern of ["/Library", "/OrbStack", "node_modules", "vendor", ".git"]) {
    assert.ok(exclude.includes(pattern), pattern);
  }
  const exclusions = DEFAULT_SETTINGS.exclusions.map((item) => ({
    ...item,
    on: item.pattern !== "vendor",
  }));
  assert.ok(!indexOptions({ ...DEFAULT_SETTINGS, exclusions }).exclude.includes("vendor"));
});

test("a new default is added once, and a deleted default stays deleted", () => {
  const patterns = (exclusions: { pattern: string }[]) => exclusions.map((item) => item.pattern);
  const all = patterns(DEFAULT_SETTINGS.exclusions);
  // Saved before eln-cache was a default, with vendor deleted and a pattern of the user.
  const saved = {
    ...DEFAULT_SETTINGS,
    exclusions: [
      ...DEFAULT_SETTINGS.exclusions.filter(
        (item) => !["vendor", "eln-cache"].includes(item.pattern),
      ),
      { pattern: "mine", on: false },
    ],
    seenDefaults: all.filter((pattern) => pattern !== "eln-cache"),
  };
  const merged = withNewDefaults(saved);
  assert.deepEqual(patterns(merged.exclusions), [...patterns(saved.exclusions), "eln-cache"]);
  assert.deepEqual(merged.seenDefaults, all);
  // Deleted again after the merge: it does not come back.
  const deleted = {
    ...merged,
    exclusions: merged.exclusions.filter((item) => item.pattern !== "eln-cache"),
  };
  assert.ok(!patterns(withNewDefaults(deleted).exclusions).includes("eln-cache"));
  // Settings saved before seenDefaults existed know every current default.
  const { seenDefaults: _, ...old } = saved;
  assert.deepEqual(withNewDefaults(old).exclusions, saved.exclusions);
});

test("search matches the path relative to its root", async () => {
  await indexed({});
  const [first] = await search(index, "srcmain", 10);
  assert.deepEqual(first, {
    root: one,
    rel: "repo/src/main.ts",
    isDir: false,
    path: join(one, "repo/src/main.ts"),
  });
  // The root path itself does not match: "copy-ref-test" is only in the root.
  assert.deepEqual(await search(index, "copyreftest", 10), []);
  assert.equal((await search(index, "r", 2)).length, 2);
  assert.equal(
    (await search(index, "repo/", 10)).find((entry) => entry.rel === "repo/")?.isDir,
    true,
  );
});

test("search only files or only folders", async () => {
  await indexed({});
  const rels = async (kind: Kind) =>
    (await search(index, "r", 10, kind)).map((entry) => entry.rel).sort();
  assert.deepEqual(await rels("folder"), ["repo/", "repo/src/"]);
  assert.deepEqual(await rels("file"), ["repo/src/main.ts"]);
  assert.deepEqual(await rels("all"), ["repo/", "repo/src/", "repo/src/main.ts"]);
  const [folder] = await search(index, "repo", 1, "folder");
  assert.ok(isKind(folder, "folder") && !isKind(folder, "file") && isKind(folder, "all"));
});

test("path relative to the repository", () => {
  assert.equal(repoRelative(join(one, "repo", "src", "main.ts")), "src/main.ts");
  assert.equal(repoRelative(join(one, "repo", "src")), "src");
  assert.equal(repoRelative(join(one, "repo")), ".");
  assert.equal(repoRelative(join(two, "notes.md")), undefined);
});

test("name of the repository", () => {
  assert.equal(repoName(join(one, "repo", "src", "main.ts")), "repo");
  assert.equal(repoName(join(one, "repo", "src")), "repo");
  assert.equal(repoName(join(one, "repo")), "repo");
  assert.equal(repoName(join(two, "notes.md")), undefined);
});

test("homepage of a git remote URL", () => {
  const host = (alias: string) => (alias === "work.gitlab.com" ? "gitlab.com" : alias);
  const cases: [string, string | undefined][] = [
    ["git@github.com:o/repo.git", "https://github.com/o/repo"],
    ["git@work.gitlab.com:group/sub/repo.git", "https://gitlab.com/group/sub/repo"],
    ["ssh://git@git.example.com:2222/o/repo.git", "https://git.example.com/o/repo"],
    ["https://github.com/o/repo.git", "https://github.com/o/repo"],
    ["https://user@gitlab.com/o/repo/", "https://gitlab.com/o/repo"],
    ["http://git.local/o/repo", "http://git.local/o/repo"],
    ["/srv/git/repo.git", undefined],
  ];
  for (const [url, homepage] of cases) assert.equal(remoteHomepage(url, host), homepage, url);
});

test("forge link of a file, a folder and the repository folder", () => {
  const hub = "https://github.com/o/repo";
  const lab = "https://git.example.com/g/repo";
  assert.equal(forgeLink(hub, "main", "lib/a b.el", false), `${hub}/blob/main/lib/a%20b.el`);
  assert.equal(forgeLink(hub, "7365d9f", "lib", true), `${hub}/tree/7365d9f/lib`);
  assert.equal(forgeLink(lab, "feat/x", "lib/file.el", false), `${lab}/-/blob/feat/x/lib/file.el`);
  assert.equal(forgeLink(lab, "main", "", true), `${lab}/-/tree/main`);
});

test("file contents: text, binary, too big and a folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-ref-file-"));
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "b.bin"), Buffer.from([1, 0, 2]));
  writeFileSync(join(dir, "big.txt"), "x".repeat(FILE_LIMIT + 1));
  assert.equal(fileText(join(dir, "a.txt")), "one\ntwo\n");
  assert.throws(() => fileText(join(dir, "b.bin")), /binary/);
  assert.throws(() => fileText(join(dir, "big.txt")), /over/);
  assert.throws(() => fileText(dir), /folder/);
});
