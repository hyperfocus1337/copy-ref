import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  HOST,
  bridgeSurfaces,
  cmuxSurfaces,
  firstText,
  hostPath,
  matchSessions,
  parseContainers,
  parseMounts,
  parseScan,
  resumeCommand,
  scanScript,
  sessionName,
  setCmuxTitles,
  shellQuote,
  toNameMode,
} from "../src/sessions.ts";

const DAY = 86_400_000;

// A home folder with one log of each agent, a Claude subagent log, and an old pi log.
const home = mkdtempSync(join(tmpdir(), "copy-ref-sessions-"));
const write = (rel: string, lines: object[], ageDays = 0) => {
  const file = join(home, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const time = new Date(Date.now() - ageDays * DAY);
  utimesSync(file, time, time);
};
const claudeId = "7b27ce22-9804-4ce4-a6e5-44a13ad35e27";
write(`.claude/projects/-w-app/${claudeId}.jsonl`, [
  { type: "user", cwd: "/w/app", message: { role: "user", content: "<command-name>/clear" } },
  {
    type: "user",
    cwd: "/w/app",
    message: { role: "user", content: [{ type: "text", text: "fix the\nbuild" }] },
  },
  { type: "ai-title", aiTitle: "Fix the build" },
  { type: "custom-title", customTitle: "first name" },
  { type: "custom-title", customTitle: "build fix" },
]);
write(`.claude/projects/-w-app/${claudeId}/subagents/agent-1.jsonl`, [
  { type: "user", isSidechain: true, cwd: "/w/app", message: { role: "user", content: "task" } },
]);
write(".codex/sessions/2026/10/27/rollout-x.jsonl", [
  { type: "session_meta", payload: { id: "codex-1", cwd: "/w/web" } },
  {
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ text: "hello codex" }] },
    },
  },
]);
write(".codex/session_index.jsonl", [
  { id: "codex-1", thread_name: "Old name" },
  { id: "codex-1", thread_name: "Codex thread" },
]);
write(".pi/agent/sessions/--w-app--/2026_pi-1.jsonl", [
  { type: "session", id: "pi-1", cwd: "/w/app" },
  { type: "message", message: { role: "user", content: [{ type: "text", text: "pi prompt" }] } },
  { type: "session_info", name: "pi name" },
  { type: "session_info", name: " " },
]);
write(
  ".pi/agent/sessions/--w-old--/2025_pi-old.jsonl",
  [{ type: "session", id: "pi-old", cwd: "/w/old" }],
  30,
);
write(".omp/agent/sessions/--w-app--/2026_omp-1.jsonl", [
  { type: "title", title: "omp title" },
  { type: "session", id: "omp-1", cwd: "/w/app" },
]);

const scan = (days: number) =>
  execFileSync("sh", ["-s"], {
    input: scanScript(days),
    encoding: "utf8",
    env: { ...process.env, HOME: home, PATH: `${process.env.PATH}:/opt/homebrew/bin` },
  });

test("scanScript and parseScan read each agent, newest first", () => {
  const sessions = parseScan(scan(14), HOST, "Host");
  assert.deepEqual(
    sessions.map((s) => s.agent).sort(),
    ["claude", "codex", "omp", "pi"],
    "no subagent, no log older than 14 days",
  );
  const by = Object.fromEntries(sessions.map((s) => [s.agent, s]));
  assert.equal(by.claude.id, claudeId);
  assert.equal(by.claude.name, "build fix", "the last custom title wins");
  assert.equal(by.claude.title, "Fix the build");
  assert.equal(by.claude.prompt, "fix the build", "a command is not the prompt; one line");
  assert.equal(by.claude.cwd, "/w/app");
  assert.equal(by.codex.id, "codex-1");
  assert.equal(by.codex.name, "Codex thread", "the last thread_name wins");
  assert.equal(by.codex.prompt, "hello codex");
  assert.equal(by.pi.name, undefined, "an empty name clears the name");
  assert.equal(by.pi.prompt, "pi prompt");
  assert.equal(by.omp.title, "omp title");
  assert.equal(by.omp.hostCwd, "/w/app", "a host session is on this Mac");
  assert.ok(
    sessions.every((s) => Date.now() - s.time < DAY),
    "time is the log mtime",
  );
  assert.equal(new Set(sessions.map((s) => s.key)).size, 4);
});

test("0 days reads all logs", () => {
  assert.equal(parseScan(scan(0), HOST, "Host").length, 5);
});

test("a container session maps its folder through the longest bind mount", () => {
  const mounts = parseMounts(
    JSON.stringify([
      { Type: "bind", Source: "/Users/me/Repositories", Destination: "/w" },
      { Type: "bind", Source: "/Users/me/web", Destination: "/w/web/" },
      { Type: "volume", Source: "/var/lib/docker/x", Destination: "/w/app" },
    ]),
  );
  assert.equal(mounts.length, 2);
  const sessions = parseScan(scan(14), "box", "sandbox", mounts);
  const by = Object.fromEntries(sessions.map((s) => [s.agent, s]));
  assert.equal(by.pi.hostCwd, "/Users/me/Repositories/app");
  assert.equal(by.codex.hostCwd, "/Users/me/web");
  assert.equal(hostPath("/elsewhere", mounts), undefined);
  assert.equal(hostPath("/wx", mounts), undefined, "a prefix is not a parent folder");
  assert.equal(by.pi.label, "sandbox");
});

test("resumeCommand", () => {
  const base = { key: "", log: "", time: 0, label: "", cwd: "/w/my app" };
  assert.equal(
    resumeCommand({ ...base, agent: "pi", place: HOST, id: "pi-1" }),
    "cd '/w/my app' && pi --session pi-1",
  );
  assert.equal(
    resumeCommand({ ...base, agent: "codex", place: HOST, id: "c", cwd: undefined }),
    "codex resume c",
  );
  assert.equal(
    resumeCommand({ ...base, agent: "omp", place: HOST, id: "o" }),
    "cd '/w/my app' && omp --resume o",
  );
  assert.equal(
    resumeCommand({ ...base, agent: "claude", place: "box", id: "x" }),
    "cas resume claude x '/w/my app'",
  );
  assert.equal(
    resumeCommand({ ...base, agent: "pi", place: "box", id: "p", cwd: undefined }),
    "cas resume pi p .",
  );
  assert.equal(resumeCommand({ ...base, agent: "pi", place: HOST }), undefined);
});

test("sessionName and matchSessions follow the name mode", () => {
  const base = { key: "", log: "", time: 0, place: HOST, label: "Host", agent: "pi" as const };
  const named = { ...base, key: "1", name: "set", title: "auto", prompt: "p", cwd: "/w/app" };
  const titled = { ...base, key: "2", title: "auto title", prompt: "p" };
  const bare = { ...base, key: "3", prompt: "only prompt" };
  const any = toNameMode("name,cmuxTitle,title,prompt");
  const titledMode = toNameMode("name,cmuxTitle,title");
  const set = toNameMode("name");
  assert.equal(sessionName(titled, any), "auto title");
  assert.equal(
    sessionName({ ...titled, cmuxTitle: "tab" }, titledMode),
    "tab",
    "cmux before agent",
  );
  assert.equal(sessionName({ ...named, cmuxTitle: "tab" }, any), "set", "set name before cmux");
  assert.equal(sessionName({ ...bare, cmuxTitle: "tab" }, set), undefined);
  assert.equal(sessionName(bare, titledMode), undefined);
  assert.equal(sessionName(titled, set), undefined);
  assert.equal(
    sessionName({ ...titled, cmuxTitle: "tab" }, toNameMode("name,title")),
    "auto title",
  );
  assert.equal(sessionName(titled, toNameMode("name,prompt")), "p", "skips the titles");
  const all = [named, titled, bare];
  assert.equal(matchSessions(all, any, "", 10).length, 3);
  assert.equal(matchSessions(all, titledMode, "", 10).length, 2);
  assert.equal(matchSessions(all, set, "", 10).length, 1);
  assert.deepEqual(
    matchSessions(all, any, "SET app", 10).map((row) => row.name),
    ["set"],
    "every word, in the name or the folder, any case",
  );
  assert.equal(matchSessions(all, any, "pi", 2).length, 2, "the limit");
  assert.deepEqual(toNameMode("titled"), ["name", "cmuxTitle", "title"], "a value saved before");
  assert.deepEqual(toNameMode("set"), ["name"]);
  assert.deepEqual(toNameMode("any"), any);
  assert.deepEqual(toNameMode("gone"), any);
  assert.deepEqual(toNameMode("name,key"), any, "only name fields");
  assert.deepEqual(toNameMode(""), any);
  assert.deepEqual(toNameMode("name,cmuxTitle"), any, "the cmux title is never last");
});

test("parseContainers, firstText, shellQuote", () => {
  assert.deepEqual(parseContainers(" a=sandbox, b ,,"), [
    { name: "a", label: "sandbox" },
    { name: "b", label: "b" },
  ]);
  assert.equal(firstText([{ type: "image" }, { text: "  a\n b " }]), "a b");
  assert.equal(firstText("   "), undefined);
  assert.equal(firstText("x".repeat(200))?.length, 120);
  assert.equal(shellQuote("/a/b-c.d"), "/a/b-c.d");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // The quoting holds in sh, so a resume command pastes into a shell as one word.
  assert.equal(
    execFileSync("sh", ["-c", `printf %s ${shellQuote("a 'b' $c")}`], { encoding: "utf8" }),
    "a 'b' $c",
  );
});

test("setCmuxTitles gives the sessions that run in cmux the title of their terminal", async () => {
  const entry = (id: string, surface: string, more: object) => ({
    session_id: id,
    surface_id: surface,
    agent: "claude",
    stored_pid_exists: true,
    ...more,
  });
  const list = {
    sessions: [
      entry("live", "S1", { active_for_surface: true }),
      entry("ended", "S2", {
        active_for_surface: true,
        stored_pid_exists: false,
      }),
      entry("closed", "S9", { active_for_surface: true }),
      entry("pi-old", "S3", { agent: "pi", updated_at_unix: 1 }),
      entry("pi-new", "S3", { agent: "pi", updated_at_unix: 2 }),
    ],
  };
  assert.deepEqual(
    [...cmuxSurfaces(list).keys()].sort(),
    ["closed", "live", "pi-new"],
    "running agents only; for Pi the last updated one of a terminal",
  );
  const tree = {
    windows: [
      {
        panes: [
          { type: "terminal", id: "s1", title: "Live tab" },
          { type: "terminal", id: "S2", title: "~/shell" },
          { type: "terminal", id: "S3", title: "Pi tab" },
          { type: "terminal", id: "S4", title: "Bridge tab" },
          { type: "terminal", id: "S5", title: "  " },
        ],
      },
    ],
  };
  const dir = mkdtempSync(join(tmpdir(), "copy-ref-bridge-"));
  const now = 1000;
  const record = (id: string, surface: string, expires: number) =>
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({
        source: "box",
        session_id: id,
        surface_id: surface,
        expires_at: expires,
      }),
    );
  record("box-pi", "S4", now + 30);
  record("expired", "S4", now - 1);
  record("far", "S4", now + 61);
  writeFileSync(join(dir, "partial.json"), "{");
  const bridge = await bridgeSurfaces(dir, now);
  assert.deepEqual([...bridge.keys()], ["box\tbox-pi"]);
  assert.equal((await bridgeSurfaces(join(dir, "missing"))).size, 0);

  const session = (id: string, place = HOST) => ({
    key: id,
    agent: "pi" as const,
    place,
    label: place,
    log: "",
    time: 0,
    id,
  });
  const sessions = [
    session("live"),
    session("ended"),
    session("closed"),
    session("pi-new"),
    session("box-pi", "box"),
    session("box-pi"),
  ];
  setCmuxTitles(sessions, list, tree, bridge);
  assert.deepEqual(
    sessions.map((item) => item.cmuxTitle),
    ["Live tab", undefined, undefined, "Pi tab", "Bridge tab", undefined],
  );
  setCmuxTitles(sessions, undefined, undefined, new Map());
  assert.equal(sessions[0].cmuxTitle, undefined, "no cmux answer, no title");
});
