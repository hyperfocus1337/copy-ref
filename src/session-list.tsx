import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  Keyboard,
  List,
  Toast,
  confirmAlert,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { useCachedPromise, useCachedState } from "@raycast/utils";
import { type ReactNode, useMemo } from "react";
import { tildePath } from "./paths";
import {
  type Agent,
  HOST,
  type Session,
  loadSessions,
  matchSessions,
  parseContainers,
  resumeCommand,
  toNameMode,
} from "./sessions";
import {
  type ViewProps,
  type ViewState,
  ViewActions,
  clearDraft,
  copy,
  showFailures,
} from "./views";

const RESULT_LIMIT = 100;
const RECENT_LIMIT = 30;
const DEFAULT_DAYS = 14;

// The session preferences in package.json.
type SessionPreferences = {
  sessionContainers: string;
  sessionUser: string;
  sessionDays: string;
  sessionName: string;
  sessionEmpty: string;
};

const AGENT_COLORS: Record<Agent, Color> = {
  claude: Color.Orange,
  codex: Color.Green,
  pi: Color.Purple,
  omp: Color.Blue,
};

// The agent sessions of the host and of the containers in the preferences.
export function useSessionView({ active, view, setView, searchText }: ViewProps): ViewState {
  const prefs = getPreferenceValues<SessionPreferences>();
  const containers = parseContainers(prefs.sessionContainers ?? "");
  const daysValid = /^\s*\d+\s*$/.test(prefs.sessionDays ?? "");
  const days = daysValid ? Number(prefs.sessionDays) : DEFAULT_DAYS;
  const mode = useMemo(() => toNameMode(prefs.sessionName), [prefs.sessionName]);
  const showRecent = searchText === "" && prefs.sessionEmpty === "recent";
  const [recent, setRecent] = useCachedState<Session[]>("recent-sessions", []);

  // Shows the sessions of the last read at once, and reads them again on each open.
  const { data, isLoading } = useCachedPromise(
    (list: string, user: string, shownDays: number) =>
      loadSessions(JSON.parse(list), user, shownDays),
    [JSON.stringify(containers), prefs.sessionUser ?? "", days],
    {
      execute: active,
      onData: ({ failed }) => {
        if (failed.length > 0) showFailures("Could not read agent sessions", failed);
        else if (!daysValid)
          showToast({
            style: Toast.Style.Failure,
            title: `Session Days "${prefs.sessionDays}" is not a whole number`,
            message: `Showing the last ${DEFAULT_DAYS} days`,
          });
      },
      failureToastOptions: { title: "Could not read agent sessions" },
    },
  );

  const rows = useMemo(() => {
    const sessions = data?.sessions ?? [];
    if (!showRecent) return matchSessions(sessions, mode, searchText, RESULT_LIMIT);
    // A recent session shows with its data of the last read, for a name set since.
    const fresh = new Map(sessions.map((session) => [session.key, session]));
    const list = recent.map((session) => fresh.get(session.key) ?? session);
    return matchSessions(list, mode, "", RECENT_LIMIT);
  }, [data, recent, showRecent, mode, searchText]);

  // A cmux title holds only while the agent runs, so a recent session does not keep it.
  const remember = (session: Session) => {
    clearDraft();
    setRecent((list) =>
      [
        { ...session, cmuxTitle: undefined },
        ...list.filter((item) => item.key !== session.key),
      ].slice(0, RECENT_LIMIT),
    );
  };

  const forget = (session: Session) =>
    setRecent((list) => list.filter((item) => item.key !== session.key));

  const clearRecent = async () => {
    const confirmed = await confirmAlert({
      title: "Clear all recent sessions?",
      primaryAction: { title: "Clear All", style: Alert.ActionStyle.Destructive },
    });
    if (confirmed) setRecent([]);
  };

  const listActions = (
    <>
      <ViewActions view={view} setView={setView} />
      <ActionPanel.Section title="Settings">
        <Action
          title="Choose Containers, Session Days and Names"
          icon={Icon.Gear}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </>
  );

  const places = ["Host", ...containers.map((container) => container.label)].join(", ");
  const placeholder = `Search agent sessions in ${places}`;
  if (!active) return { isLoading: false, placeholder, children: null };
  return {
    isLoading,
    placeholder,
    children: (
      <>
        <List.EmptyView
          title={
            showRecent ? "No recent sessions" : searchText ? "No sessions match" : "No sessions"
          }
          actions={<ActionPanel>{listActions}</ActionPanel>}
        />
        <List.Section title={showRecent ? "Recent" : searchText ? "Results" : "Newest"}>
          {rows.map(({ session, name }) => (
            <SessionItem
              key={session.key}
              session={session}
              name={name}
              onUse={remember}
              recentActions={
                showRecent && (
                  <ActionPanel.Section title="Recent">
                    <Action
                      title="Remove from Recent"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.Remove}
                      onAction={() => forget(session)}
                    />
                    <Action
                      title="Clear All Recent"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.RemoveAll}
                      onAction={clearRecent}
                    />
                  </ActionPanel.Section>
                )
              }
              listActions={listActions}
            />
          ))}
        </List.Section>
      </>
    ),
  };
}

function SessionItem({
  session,
  name,
  onUse,
  recentActions,
  listActions,
}: {
  session: Session;
  name: string;
  onUse: (session: Session) => void;
  recentActions: ReactNode;
  listActions: ReactNode;
}) {
  // The folder on this Mac, else the folder in the container.
  const folder = session.hostCwd ? tildePath(session.hostCwd) : session.cwd;
  const used = () => onUse(session);
  const host = session.place === HOST;
  return (
    <List.Item
      title={name}
      subtitle={folder}
      icon={{ source: Icon.Terminal, tintColor: AGENT_COLORS[session.agent] }}
      accessories={[
        { tag: { value: session.agent, color: AGENT_COLORS[session.agent] } },
        {
          icon: host ? Icon.Desktop : Icon.Box,
          text: session.label,
          tooltip: host ? "This Mac" : `Container ${session.place}`,
        },
        { date: new Date(session.time), tooltip: "Last change of the log" },
      ]}
      actions={
        <ActionPanel>
          <Action title="Copy Name" icon={Icon.Clipboard} onAction={() => copy(() => name, used)} />
          {/* The second action gets Cmd+Return only without a shortcut of its own. */}
          <Action
            title="Copy Session ID"
            icon={Icon.Clipboard}
            onAction={() => copy(() => session.id, used, "The log gives no session id")}
          />
          <Action
            title="Copy Resume Command"
            icon={Icon.Terminal}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={() => copy(() => resumeCommand(session), used, "The log gives no session id")}
          />
          <Action
            title="Copy Session Folder"
            icon={Icon.Folder}
            shortcut={{ modifiers: ["cmd"], key: "-" }}
            onAction={() => copy(() => folder, used, "The log gives no folder")}
          />
          <Action.Paste
            title="Paste Name"
            content={name}
            shortcut={{ modifiers: ["shift"], key: "return" }}
            onPaste={used}
          />
          {recentActions}
          {listActions}
        </ActionPanel>
      }
    />
  );
}
