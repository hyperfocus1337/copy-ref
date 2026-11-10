import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// The agent sessions of claude, codex, pi and omp, on the host and in Docker containers.
// One shell script finds the logs of each agent and prints only the lines that give the id,
// the folder, a name, a title or the first prompt. The same script runs on the host and,
// through docker exec, in each container, where the logs are in volumes that the host
// cannot read.

export type Agent = "claude" | "codex" | "pi" | "omp";

// dir is the log folder under the home folder. names matches the lines that give the id,
// the folder, a name or a title, and prompt the line of the first prompt, of which rg reads
// only the first match. Claude Code writes a prompt as a string or as a list of parts, and a
// prompt that starts with "<" is a command, not a prompt.
export const AGENTS: Record<Agent, { dir: string; names: string; prompt: string }> = {
  claude: {
    dir: ".claude/projects",
    names: '"type":"(custom-title|ai-title)"',
    prompt: '"message":\\{"role":"user","content":("[^<]|\\[\\{"type":"text","text":"[^<])',
  },
  codex: { dir: ".codex/sessions", names: '"type":"session_meta"', prompt: '"type":"UserMessage"' },
  pi: { dir: ".pi/agent/sessions", names: '"type":"session', prompt: '"message":\\{"role":"user"' },
  omp: {
    dir: ".omp/agent/sessions",
    names: '"type":"(session|title)"',
    prompt: '"message":\\{"role":"user"',
  },
};

export const HOST = "host";

// place is HOST or the name of the container, and label the text that the list shows for it.
// time is the last change of the log, in milliseconds since 1970. cwd is the folder of the
// session where it ran; hostCwd the same folder on this Mac, when a bind mount holds it.
// name is the name that the user set, title the one that the agent made, and cmuxTitle the
// title of the cmux terminal where the agent runs now.
export type Session = {
  key: string;
  agent: Agent;
  place: string;
  label: string;
  log: string;
  time: number;
  id?: string;
  cwd?: string;
  hostCwd?: string;
  name?: string;
  title?: string;
  cmuxTitle?: string;
  prompt?: string;
};

// A container to read: the Docker name and the label of the list.
export type Container = { name: string; label: string };

// A bind mount of a container.
export type Mount = { source: string; destination: string };

// What the list shows as the name of a session: the first of these session fields that has a
// text. The Session Name preference gives them separated by commas, such as "name,title". A
// session with no such text is not in the list. The cmux title is never last: it goes when
// the agent ends, and the session would then go from the list.
export type NameField = "name" | "cmuxTitle" | "title" | "prompt";
export type NameMode = NameField[];

const NAME_FIELDS: NameField[] = ["name", "cmuxTitle", "title", "prompt"];

// The values of Session Name before the cmux title, which a saved preference can still hold.
const OLD_MODES: Record<string, string> = {
  any: "name,cmuxTitle,title,prompt",
  titled: "name,cmuxTitle,title",
  set: "name",
};

export function toNameMode(value: string | undefined): NameMode {
  const fields = (OLD_MODES[value ?? ""] ?? value ?? "").split(",");
  return fields.every((field) => NAME_FIELDS.includes(field as NameField)) &&
    fields.at(-1) !== "cmuxTitle"
    ? (fields as NameMode)
    : NAME_FIELDS;
}

export function sessionName(session: Session, mode: NameMode): string | undefined {
  for (const field of mode) if (session[field]) return session[field];
  return undefined;
}

// A text in single quotes for sh and fish, unless it needs none.
export function shellQuote(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

// The script that prints the lines to read, for logs changed in the last days, or all logs
// at 0 days. Each line is "mtime <seconds> <log>", or a log, a NUL and a line of it. GNU
// stat (Linux) and BSD stat (macOS) take other flags. The script ends with status 0, so a
// failure of docker exec is the only failure.
export function scanScript(days: number): string {
  const age = days > 0 ? ` -mtime -${days}` : "";
  const rg = "rg --null --with-filename --no-line-number --no-messages";
  const lines = ["if stat -c %Y / >/dev/null 2>&1; then s=-c f='%Y %n'; else s=-f f='%m %N'; fi"];
  for (const { dir, names, prompt } of Object.values(AGENTS)) {
    // The logs of Claude Code subagents are in <id>/subagents/; they are not sessions.
    const find = `find "$HOME"/${dir} -name subagents -prune -o -name '*.jsonl'${age}`;
    lines.push(
      `${find} -exec stat "$s" "$f" {} + 2>/dev/null | sed 's/^/mtime /'`,
      `${find} -exec ${rg} -e ${shellQuote(names)} {} + 2>/dev/null`,
      `${find} -exec ${rg} --max-count 1 -e ${shellQuote(prompt)} {} + 2>/dev/null`,
    );
  }
  // Codex keeps the names of its sessions in one file; a later line renames.
  lines.push(`${rg} -e thread_name "$HOME"/.codex/session_index.jsonl`, "exit 0");
  return lines.join("\n") + "\n";
}

// The first text of a prompt: a string, or the first part with a text. One line of at most
// PROMPT_LIMIT characters, as a name.
const PROMPT_LIMIT = 120;

export function firstText(content: unknown): string | undefined {
  let text: unknown = content;
  if (Array.isArray(content)) text = content.find((part) => typeof part?.text === "string")?.text;
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return undefined;
  return line.length > PROMPT_LIMIT ? `${line.slice(0, PROMPT_LIMIT - 1)}…` : line;
}

function agentOf(log: string): Agent | undefined {
  return (Object.keys(AGENTS) as Agent[]).find((agent) => log.includes(`/${AGENTS[agent].dir}/`));
}

// A parsed log line. Its fields depend on the agent and the line type.
type Line = any;

// Adds a log line to its session. rg prints the lines of a log in order, so a later name wins.
function readLine(session: Session, entry: Line) {
  switch (session.agent) {
    case "claude":
      session.cwd ??= entry.cwd;
      if (entry.type === "custom-title") session.name = entry.customTitle || undefined;
      else if (entry.type === "ai-title") session.title = entry.aiTitle || undefined;
      else if (entry.type === "user" && !entry.isSidechain)
        session.prompt ??= firstText(entry.message?.content);
      break;
    case "codex":
      if (entry.type === "session_meta") {
        session.id = entry.payload?.id;
        session.cwd = entry.payload?.cwd;
      } else if (entry.payload?.item?.type === "UserMessage")
        session.prompt ??= firstText(entry.payload.item.content);
      break;
    default:
      if (entry.type === "session") {
        session.id = entry.id;
        session.cwd = entry.cwd;
      } else if (entry.type === "session_info") {
        // An empty name clears the name.
        session.name = String(entry.name ?? "").trim() || undefined;
      } else if (entry.type === "title") session.title = entry.title || undefined;
      else if (entry.type === "message" && entry.message?.role === "user")
        session.prompt ??= firstText(entry.message.content);
  }
}

// The path on this Mac of path in a container, through the longest bind mount that holds it.
export function hostPath(path: string, mounts: Mount[]): string | undefined {
  let best: Mount | undefined;
  for (const mount of mounts) {
    const dest = mount.destination.replace(/\/+$/, "");
    if (
      (path === dest || path.startsWith(`${dest}/`)) &&
      dest.length > (best?.destination.length ?? -1)
    )
      best = { source: mount.source, destination: dest };
  }
  return best && best.source + path.slice(best.destination.length);
}

// The bind mounts in the output of docker inspect --format '{{json .Mounts}}'.
export function parseMounts(output: string): Mount[] {
  const mounts = JSON.parse(output || "[]") as {
    Type: string;
    Source: string;
    Destination: string;
  }[];
  return (mounts ?? [])
    .filter((mount) => mount.Type === "bind")
    .map((mount) => ({ source: mount.Source, destination: mount.Destination }));
}

// The sessions in the output of scanScript, newest first.
export function parseScan(
  output: string,
  place: string,
  label: string,
  mounts: Mount[] = [],
): Session[] {
  const sessions = new Map<string, Session>();
  const names = new Map<string, string>();
  const get = (log: string) => {
    let session = sessions.get(log);
    const agent = agentOf(log);
    if (!session && agent) {
      session = { key: "", agent, place, label, log, time: 0 };
      sessions.set(log, session);
    }
    return session;
  };
  for (const line of output.split("\n")) {
    const nul = line.indexOf("\0");
    if (nul < 0) {
      const match = /^mtime (\d+) (.+)$/.exec(line);
      const session = match && get(match[2]);
      if (session) session.time = Number(match[1]) * 1000;
      continue;
    }
    const log = line.slice(0, nul);
    let entry: Line;
    try {
      entry = JSON.parse(line.slice(nul + 1));
    } catch {
      continue;
    }
    if (log.endsWith("/.codex/session_index.jsonl")) {
      if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name);
      continue;
    }
    const session = get(log);
    if (session) readLine(session, entry);
  }
  for (const session of sessions.values()) {
    if (session.agent === "claude")
      session.id = session.log.replace(/^.*\//, "").replace(/\.jsonl$/, "");
    if (session.agent === "codex" && session.id)
      session.name = names.get(session.id) ?? session.name;
    session.hostCwd = place === HOST ? session.cwd : session.cwd && hostPath(session.cwd, mounts);
    session.key = [place, session.agent, session.id ?? session.log].join("\t");
  }
  return [...sessions.values()].sort((a, b) => b.time - a.time);
}

// The command that resumes session: on the host the agent in the folder of the session,
// because pi looks for the id among the sessions of its folder; in a container cas, a
// sandbox command that takes the folder in the container.
export function resumeCommand(session: Session): string | undefined {
  const { agent, id, cwd } = session;
  if (!id) return undefined;
  if (session.place !== HOST)
    return ["cas", "resume", agent, id, cwd ?? "."].map(shellQuote).join(" ");
  const args = {
    claude: ["claude", "--resume", id],
    codex: ["codex", "resume", id],
    pi: ["pi", "--session", id],
    omp: ["omp", "--resume", id],
  }[agent];
  const command = args.map(shellQuote).join(" ");
  return cwd ? `cd ${shellQuote(cwd)} && ${command}` : command;
}

// The sessions whose name, folder, agent or place holds each word of query, at most limit.
export function matchSessions(
  sessions: Session[],
  mode: NameMode,
  query: string,
  limit: number,
): { session: Session; name: string }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found: { session: Session; name: string }[] = [];
  for (const session of sessions) {
    const name = sessionName(session, mode);
    if (name === undefined) continue;
    const text = [name, session.hostCwd ?? session.cwd, session.agent, session.label]
      .join(" ")
      .toLowerCase();
    if (words.every((word) => text.includes(word))) found.push({ session, name });
    if (found.length === limit) break;
  }
  return found;
}

// The Session Containers preference: "name" or "name=label", separated by commas.
export function parseContainers(text: string): Container[] {
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const [name, label] = item.split("=").map((part) => part.trim());
      return { name, label: label || name };
    });
}

// An agent session in the output of cmux sessions list --json --all.
type CmuxEntry = {
  session_id?: string;
  surface_id?: string;
  agent?: string;
  active_for_surface?: boolean;
  active_surface_session_id?: string | null;
  stored_pid_exists?: boolean;
  updated_at_unix?: number;
};

// The title of each cmux terminal by its id in lower case, from the output of
// cmux --json tree --all --id-format uuids, with the terminals at any depth.
export function terminalTitles(tree: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      const node = value as Record<string, unknown>;
      if (
        node.type === "terminal" &&
        typeof node.id === "string" &&
        typeof node.title === "string" &&
        node.title.trim() !== ""
      )
        titles.set(node.id.toLowerCase(), node.title);
      Object.values(node).forEach(walk);
    }
  };
  walk(tree);
  return titles;
}

// The terminal of each session id whose agent still runs in cmux, from the output of
// cmux sessions list --json --all: the active session of a terminal, or for Pi, which cmux
// does not always mark active, the last updated one of its terminal. An agent that ended
// leaves its terminal to a shell, with the title of the shell.
export function cmuxSurfaces(list: unknown): Map<string, string> {
  const entries = (list as { sessions?: CmuxEntry[] } | null)?.sessions ?? [];
  const surfaces = new Map<string, string>();
  const pi = new Map<string, CmuxEntry>();
  for (const entry of entries) {
    const { session_id: id, surface_id: surface } = entry;
    if (!entry.stored_pid_exists || !id || !surface) continue;
    if (entry.active_for_surface) surfaces.set(id, surface);
    else if (entry.agent === "pi" && !entry.active_surface_session_id) {
      const other = pi.get(surface.toLowerCase());
      if ((other?.updated_at_unix ?? -1) < (entry.updated_at_unix ?? 0))
        pi.set(surface.toLowerCase(), entry);
    }
  }
  for (const entry of pi.values()) surfaces.set(entry.session_id!, entry.surface_id!);
  return surfaces;
}

// The terminal of each container Pi session by "<container>\t<id>", from the files of the
// host bridge in $XDG_STATE_HOME/agent-cmux. The bridge renews a file while the session runs,
// so a file that expired, or expires more than 60 s ahead, is stale.
export async function bridgeSurfaces(
  dir = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "agent-cmux"),
  now = Date.now() / 1000,
): Promise<Map<string, string>> {
  const surfaces = new Map<string, string>();
  const files = await readdir(dir).catch(() => []);
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    try {
      const record = JSON.parse(await readFile(join(dir, file), "utf8"));
      const { source, session_id: id, surface_id: surface, expires_at: expires } = record;
      if (
        [source, id, surface].every((value) => typeof value === "string" && value !== "") &&
        typeof expires === "number" &&
        now < expires &&
        expires <= now + 60
      )
        surfaces.set(`${source}\t${id}`, surface);
    } catch {
      // A file that the bridge writes now, or that is not JSON, gives no terminal.
    }
  }
  return surfaces;
}

// Gives each session whose agent runs in a cmux terminal the title of that terminal.
export function setCmuxTitles(
  sessions: Session[],
  list: unknown,
  tree: unknown,
  bridge: Map<string, string>,
) {
  const titles = terminalTitles(tree);
  const surfaces = cmuxSurfaces(list);
  for (const session of sessions) {
    if (!session.id) continue;
    const surface = surfaces.get(session.id) ?? bridge.get(`${session.place}\t${session.id}`);
    session.cmuxTitle = surface && titles.get(surface.toLowerCase());
  }
}

// The cmux CLI is in the app bundle, not on a PATH that Raycast knows.
const CMUX_BIN = "/Applications/cmux.app/Contents/Resources/bin";
const CMUX_TIMEOUT_MS = 3_000;

// Raycast starts extensions with a minimal PATH, without Homebrew, where rg and docker are.
const env = {
  ...process.env,
  PATH: `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin:${CMUX_BIN}`,
};

const TIMEOUT_MS = 10_000;

// The output of command, with input on stdin. Throws the error output when it fails.
export function run(
  command: string,
  args: string[],
  input = "",
  timeout = TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} did not end in ${timeout / 1000} s`));
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else
        reject(
          new Error(Buffer.concat(err).toString("utf8").trim() || `${command} exited with ${code}`),
        );
    });
    child.stdin.end(input);
  });
}

// The sessions of the host and of the containers, newest first, and a "<place>: <reason>"
// line for each container that could not be read. The others still show. When cmux does
// not answer, as when it does not run, no session has a cmux title.
export async function loadSessions(
  containers: Container[],
  user: string,
  days: number,
): Promise<{ sessions: Session[]; failed: string[] }> {
  const script = scanScript(days);
  const userArgs = user ? ["-u", user] : [];
  const reads = [
    run("sh", ["-s"], script).then((output) => parseScan(output, HOST, "Host")),
    ...containers.map(async ({ name, label }) => {
      const [output, mounts] = await Promise.all([
        run("docker", ["exec", "-i", ...userArgs, name, "sh", "-s"], script),
        run("docker", ["inspect", "--format", "{{json .Mounts}}", name]),
      ]);
      return parseScan(output, name, label, parseMounts(mounts));
    }),
  ];
  const cmux = (args: string[]) =>
    run("cmux", args, "", CMUX_TIMEOUT_MS)
      .then((output) => JSON.parse(output) as unknown)
      .catch(() => undefined);
  const [results, list, tree, bridge] = await Promise.all([
    Promise.allSettled(reads),
    cmux(["sessions", "list", "--json", "--all"]),
    cmux(["--json", "tree", "--all", "--id-format", "uuids"]),
    bridgeSurfaces(),
  ]);
  const sessions: Session[] = [];
  const failed: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") sessions.push(...result.value);
    else
      failed.push(
        `${i === 0 ? "Host" : containers[i - 1].label}: ${(result.reason as Error).message}`,
      );
  });
  setCmuxTitles(sessions, list, tree, bridge);
  return { sessions: sessions.sort((a, b) => b.time - a.time), failed };
}
