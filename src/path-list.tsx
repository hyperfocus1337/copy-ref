import {
  Action,
  ActionPanel,
  Alert,
  Icon,
  Keyboard,
  LaunchType,
  List,
  Toast,
  confirmAlert,
  environment,
  getPreferenceValues,
  launchCommand,
  showToast,
} from "@raycast/api";
import { useCachedState, useLocalStorage, usePromise } from "@raycast/utils";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type ReactNode, useState } from "react";
import {
  DEFAULT_PASTE,
  DEFAULT_SETTINGS,
  type Entry,
  type IndexOptions,
  type Kind,
  type Mount,
  PASTE_KEY,
  PASTE_TITLES,
  type PasteKind,
  SETTINGS_KEY,
  type Settings,
  buildIndex,
  devcontainerPath,
  fileText,
  gitHomepage,
  gitLink,
  indexOptions,
  isKind,
  parseRoots,
  pasteText,
  readMounts,
  repoName,
  repoRelative,
  search,
  tildePath,
  toPasteKind,
  withNewDefaults,
} from "./paths";
import { VIEWS, type ViewProps, type ViewState, ViewActions, clearDraft, copy } from "./views";

// All path commands share the index and the recent paths.
const INDEX = join(environment.supportPath, "index.tsv");
const RESULT_LIMIT = 100;
const RECENT_LIMIT = 30;

// The bind mounts of the Compose File preference, read once per command run.
let mountsCache: Mount[] | undefined;
const composeFile = () => getPreferenceValues<{ composeFile?: string }>().composeFile ?? "";
const composeMounts = () => (mountsCache ??= readMounts(composeFile()));

// The files and folders under the root folders, of kind.
export function usePathView({
  active,
  kind,
  view,
  setView,
  searchText,
}: ViewProps & { kind: Kind }): ViewState {
  const { value: stored = DEFAULT_SETTINGS, isLoading: loadingSettings } =
    useLocalStorage<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS);
  const settings = withNewDefaults(stored);
  const roots = parseRoots(settings.roots);
  // Goes up after each index build, so the search runs again on the new index.
  const [indexVersion, setIndexVersion] = useState(() => (existsSync(INDEX) ? 1 : 0));
  const [recent, setRecent] = useCachedState<Entry[]>("recent", []);
  const { value: storedPaste } = useLocalStorage<string>(PASTE_KEY, DEFAULT_PASTE);
  const paste = toPasteKind(storedPaste);

  // Builds the index again on each open. Searches use the old index until the new one is ready.
  const { isLoading: indexing } = usePromise(
    // A string argument, so a new object on each render does not start a new build.
    (config: string) => {
      const { folders, options } = JSON.parse(config) as {
        folders: string[];
        options: IndexOptions;
      };
      return buildIndex(folders, options, INDEX);
    },
    [JSON.stringify({ folders: roots, options: indexOptions(settings) })],
    {
      execute: !loadingSettings,
      onData: () => setIndexVersion((version) => version + 1),
      failureToastOptions: { title: "Could not index the root folders" },
    },
  );

  const { data: results = [], isLoading: searching } = usePromise(
    (query: string, shown: Kind, _version: number) => search(INDEX, query, RESULT_LIMIT, shown),
    [searchText, kind, indexVersion],
    { execute: active && searchText !== "" && indexVersion > 0 },
  );

  const remember = (entry: Entry) => {
    clearDraft();
    setRecent((list) =>
      [entry, ...list.filter((item) => item.path !== entry.path)].slice(0, RECENT_LIMIT),
    );
  };

  const forget = (entry: Entry) =>
    setRecent((list) => list.filter((item) => item.path !== entry.path));

  const clearRecent = async () => {
    const confirmed = await confirmAlert({
      title: "Clear all recent paths?",
      message: "This also clears the recent paths of the other Copy Paths commands.",
      primaryAction: { title: "Clear All", style: Alert.ActionStyle.Destructive },
    });
    if (confirmed) setRecent([]);
  };

  const listActions = (
    <>
      <ViewActions view={view} setView={setView} />
      <ActionPanel.Section title="Settings">
        <Action
          title="Manage Root Folders"
          icon={Icon.Folder}
          shortcut={{ modifiers: ["cmd", "shift"], key: "r" }}
          onAction={() =>
            launchCommand({ name: "manage-root-folders", type: LaunchType.UserInitiated })
          }
        />
        <Action
          title="Manage Exclusions"
          icon={Icon.EyeDisabled}
          shortcut={{ modifiers: ["cmd", "shift"], key: "e" }}
          onAction={() =>
            launchCommand({ name: "manage-exclusions", type: LaunchType.UserInitiated })
          }
        />
        <Action
          title="Set Shift+Return Paste"
          icon={Icon.Gear}
          onAction={() =>
            launchCommand({ name: "set-shift-return-paste", type: LaunchType.UserInitiated })
          }
        />
      </ActionPanel.Section>
    </>
  );

  const showRecent = searchText === "";
  const title = VIEWS.find((item) => item.view === kind)!.title;
  const placeholder = `Search ${title.toLowerCase()} in ${roots.map(tildePath).join(", ")}`;
  if (!active) return { isLoading: false, placeholder, children: null };
  return {
    isLoading: indexing || searching,
    placeholder,
    children: (
      <>
        <List.EmptyView
          title={
            roots.length === 0
              ? "No root folders"
              : showRecent
                ? "No recent paths"
                : `No ${title.toLowerCase()} match`
          }
          description={roots.length === 0 ? "Add one with Manage Root Folders (⌘⇧R)" : undefined}
          actions={<ActionPanel>{listActions}</ActionPanel>}
        />
        <List.Section title={showRecent ? "Recent" : "Results"}>
          {(showRecent ? recent.filter((entry) => isKind(entry, kind)) : results).map((entry) => (
            <PathItem
              key={entry.path}
              entry={entry}
              showRoot={roots.length > 1}
              onUse={remember}
              recentActions={
                showRecent && (
                  <ActionPanel.Section title="Recent">
                    <Action
                      title="Remove from Recent"
                      icon={Icon.Trash}
                      style={Action.Style.Destructive}
                      shortcut={Keyboard.Shortcut.Common.Remove}
                      onAction={() => forget(entry)}
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
              paste={paste}
              listActions={listActions}
            />
          ))}
        </List.Section>
      </>
    ),
  };
}

function PathItem({
  entry,
  showRoot,
  onUse,
  recentActions,
  paste,
  listActions,
}: {
  entry: Entry;
  showRoot: boolean;
  onUse: (entry: Entry) => void;
  recentActions: ReactNode;
  paste: PasteKind;
  listActions: ReactNode;
}) {
  const parent = dirname(entry.isDir ? entry.rel.slice(0, -1) : entry.rel);
  // tildePath returns the absolute path for a path outside the home folder.
  const tilde = tildePath(entry.path);
  const pasted = pasteText(entry.path, paste, composeMounts());
  const used = () => onUse(entry);
  return (
    <List.Item
      title={basename(entry.path)}
      subtitle={parent === "." ? "" : parent}
      icon={{ fileIcon: entry.path }}
      accessories={showRoot ? [{ text: basename(entry.root) }] : []}
      actions={
        <ActionPanel>
          {/* The ~ path, or the absolute path outside the home folder. */}
          <Action
            title="Copy Path"
            icon={Icon.Clipboard}
            onAction={() => copy(() => tilde, used)}
          />
          {/* The second action gets Cmd+Return only without a shortcut of its own: Raycast
              2 shows an own shortcut in place of Cmd+Return. */}
          <Action
            title="Copy Path Relative to Repository"
            icon={Icon.Clipboard}
            onAction={() =>
              copy(() => repoRelative(entry.path), used, "Not inside a git repository")
            }
          />
          <Action
            title="Copy Devcontainer Path"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "d" }}
            onAction={() =>
              copy(
                () => devcontainerPath(entry.path, composeMounts()),
                used,
                composeFile()
                  ? "No devcontainer mount holds this path"
                  : "Set the Compose File preference first",
              )
            }
          />
          <Action
            title="Copy Folder Path"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "-" }}
            onAction={() =>
              copy(() => tildePath(entry.isDir ? entry.path : dirname(entry.path)), used)
            }
          />
          <Action
            title="Copy Name"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "n" }}
            onAction={() => copy(() => basename(entry.path), used)}
          />
          <Action
            title="Copy Repository Name"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={() => copy(() => repoName(entry.path), used, "Not inside a git repository")}
          />
          <Action
            title="Copy File Contents"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd"], key: "f" }}
            onAction={() =>
              copy(
                () => fileText(entry.path),
                used,
                undefined,
                (text) => `Copied ${lineCount(text)} lines of ${basename(entry.path)}`,
              )
            }
          />
          <Action
            title="Copy Git Link"
            icon={Icon.Link}
            shortcut={{ modifiers: ["cmd"], key: "g" }}
            onAction={() => copy(() => gitLink(entry.path, entry.isDir, false), used)}
          />
          <Action
            title="Copy Git Permalink"
            icon={Icon.Link}
            shortcut={{ modifiers: ["cmd", "shift"], key: "g" }}
            onAction={() => copy(() => gitLink(entry.path, entry.isDir, true), used)}
          />
          <Action
            title="Copy Git Homepage"
            icon={Icon.Link}
            shortcut={{ modifiers: ["cmd", "shift"], key: "w" }}
            onAction={() => copy(() => gitHomepage(entry.path), used)}
          />
          {pasted === undefined ? (
            <Action
              title={`Paste ${PASTE_TITLES[paste]}`}
              icon={Icon.Clipboard}
              shortcut={{ modifiers: ["shift"], key: "return" }}
              onAction={() =>
                showToast({ style: Toast.Style.Failure, title: `No ${PASTE_TITLES[paste]}` })
              }
            />
          ) : (
            <Action.Paste
              title={`Paste ${PASTE_TITLES[paste]}`}
              content={pasted}
              shortcut={{ modifiers: ["shift"], key: "return" }}
              onPaste={() => onUse(entry)}
            />
          )}
          {recentActions}
          {listActions}
        </ActionPanel>
      }
    />
  );
}

// The number of lines of text; a last newline does not start a line.
function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}
