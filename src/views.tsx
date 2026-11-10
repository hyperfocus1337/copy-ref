import {
  Action,
  ActionPanel,
  Cache,
  Clipboard,
  Icon,
  List,
  Toast,
  showHUD,
  showToast,
} from "@raycast/api";
import type { ReactNode } from "react";
import type { Kind } from "./paths";

// The views of the search command. Each view is a list module: path-list, history-list and
// session-list. A switch keeps the search text and the open command.
export type View = Kind | "url" | "session";

export const VIEWS: { view: View; title: string; key: "a" | "f" | "d" | "u" | "s" }[] = [
  { view: "all", title: "Files and Folders", key: "a" },
  { view: "file", title: "Files", key: "f" },
  { view: "folder", title: "Folders", key: "d" },
  { view: "url", title: "Browser History", key: "u" },
  { view: "session", title: "Agent Sessions", key: "s" },
];

// What each view hook gets from search.tsx. A hook runs on each render, also when its view
// does not show; active tells it to load nothing and to build no rows.
export type ViewProps = {
  active: boolean;
  view: View;
  setView: (view: View) => void;
  searchText: string;
};

// What a view hook gives search.tsx for the one List.
export type ViewState = { isLoading: boolean; placeholder: string; children: ReactNode };

// The search text of the last command, so another command can open with it.
// A copy or paste clears it; otherwise it expires after DRAFT_MS.
const DRAFT_MS = 30_000;
const cache = new Cache();

export function readDraft(): string {
  const draft = cache.get("draft");
  if (draft === undefined) return "";
  const { text, time } = JSON.parse(draft) as { text: string; time: number };
  return Date.now() - time < DRAFT_MS ? text : "";
}

export function writeDraft(text: string) {
  cache.set("draft", JSON.stringify({ text, time: Date.now() }));
}

export function clearDraft() {
  cache.remove("draft");
}

export function ViewDropdown({ view, setView }: Pick<ViewProps, "view" | "setView">) {
  return (
    <List.Dropdown tooltip="Show" value={view} onChange={(value) => setView(value as View)}>
      {VIEWS.map((item) => (
        <List.Dropdown.Item key={item.view} title={item.title} value={item.view} />
      ))}
    </List.Dropdown>
  );
}

// ⌘⇧ and the key of a view switch to it in place, so the search text stays.
export function ViewActions({ view, setView }: Pick<ViewProps, "view" | "setView">) {
  return (
    <ActionPanel.Section title="Show">
      {VIEWS.filter((item) => item.view !== view).map((item) => (
        <Action
          key={item.view}
          title={`Show ${item.title}`}
          icon={Icon.Filter}
          shortcut={{ modifiers: ["cmd", "shift"], key: item.key }}
          onAction={() => setView(item.view)}
        />
      ))}
    </ActionPanel.Section>
  );
}

// Copies the text of get and shows it in the HUD.
// When get returns undefined, shows failure; when it throws, shows the error message.
// Then copies nothing.
export async function copy(
  get: () => string | undefined,
  onCopy: () => void,
  failure = "Nothing to copy",
  hud = (text: string) => `Copied ${text}`,
) {
  let text: string | undefined;
  try {
    text = get();
  } catch (error) {
    failure = (error as Error).message;
  }
  if (text === undefined) {
    await showToast({ style: Toast.Style.Failure, title: failure });
    return;
  }
  await Clipboard.copy(text);
  onCopy();
  await showHUD(hud(text));
}

// A failure toast with a Copy Error action, for reads that fail in part.
export function showFailures(title: string, failed: string[]) {
  showToast({
    style: Toast.Style.Failure,
    title,
    message: failed.join("\n"),
    primaryAction: {
      title: "Copy Error",
      onAction: (toast) => {
        Clipboard.copy(failed.join("\n"));
        toast.hide();
      },
    },
  });
}
