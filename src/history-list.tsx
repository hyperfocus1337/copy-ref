import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  getPreferenceValues,
  openExtensionPreferences,
  showToast,
} from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { type ReactNode, useMemo } from "react";
import {
  BROWSERS,
  type Browser,
  type HistoryEntry,
  displayTitle,
  loadHistory,
  markdownLink,
  matchHistory,
  parseDays,
} from "./history";
import {
  type ViewProps,
  type ViewState,
  ViewActions,
  clearDraft,
  copy,
  showFailures,
} from "./views";

const RESULT_LIMIT = 100;
const DEFAULT_DAYS = 90;

// The history preferences in package.json.
type HistoryPreferences = { historyEdge: boolean; historyBrave: boolean; historyDays: string };

// The browser history of Edge and Brave.
export function useHistoryView({ active, view, setView, searchText }: ViewProps): ViewState {
  const prefs = getPreferenceValues<HistoryPreferences>();
  const browsers: Browser[] = [];
  if (prefs.historyEdge) browsers.push("edge");
  if (prefs.historyBrave) browsers.push("brave");
  const days = parseDays(prefs.historyDays);

  // Reads the history each time this list opens: at launch, and on each switch to it.
  // A search filters it in memory.
  const { data: history, isLoading } = usePromise(
    (list: string, shownDays: number) => loadHistory(JSON.parse(list) as Browser[], shownDays),
    [JSON.stringify(browsers), days ?? DEFAULT_DAYS],
    {
      execute: active && browsers.length > 0,
      onData: ({ failed }) => {
        if (failed.length > 0) showFailures("Could not read browser history", failed);
        else if (days === undefined)
          showToast({
            style: Toast.Style.Failure,
            title: `History Days "${prefs.historyDays}" is not a whole number`,
            message: `Searching the last ${DEFAULT_DAYS} days`,
          });
      },
      failureToastOptions: { title: "Could not read browser history" },
    },
  );
  const urls = useMemo(
    () => matchHistory(history?.entries ?? [], searchText, RESULT_LIMIT),
    [history, searchText],
  );

  const listActions = (
    <>
      <ViewActions view={view} setView={setView} />
      <ActionPanel.Section title="Settings">
        <Action
          title="Choose Browsers and History Days"
          icon={Icon.Globe}
          onAction={openExtensionPreferences}
        />
      </ActionPanel.Section>
    </>
  );

  const showRecent = searchText === "";
  const placeholder = `Search browser history in ${browsers.map((b) => BROWSERS[b].title).join(", ")}`;
  if (!active) return { isLoading: false, placeholder, children: null };
  return {
    isLoading,
    placeholder,
    children: (
      <>
        <List.EmptyView
          title={
            browsers.length === 0
              ? "No browsers turned on"
              : showRecent
                ? "No browser history"
                : "No URLs match"
          }
          description={
            browsers.length === 0 ? "Turn on Edge or Brave in the extension preferences" : undefined
          }
          actions={<ActionPanel>{listActions}</ActionPanel>}
        />
        <List.Section title={showRecent ? "Recently Visited" : "Results"}>
          {urls.map((entry) => (
            <HistoryItem
              key={entry.url}
              entry={entry}
              onUse={clearDraft}
              listActions={listActions}
            />
          ))}
        </List.Section>
      </>
    ),
  };
}

function HistoryItem({
  entry,
  onUse,
  listActions,
}: {
  entry: HistoryEntry;
  onUse: () => void;
  listActions: ReactNode;
}) {
  // The browsers of the URL, the one of the latest visit first.
  const browsers = [...new Set(entry.sources.map((source) => source.browser))];
  const app = (browser: Browser) => `/Applications/${BROWSERS[browser].app}.app`;
  return (
    <List.Item
      title={displayTitle(entry)}
      subtitle={entry.url}
      icon={Icon.Globe}
      accessories={[
        ...browsers.map((browser) => ({
          icon: { fileIcon: app(browser) },
          tooltip: `${BROWSERS[browser].title}: ${entry.sources
            .filter((source) => source.browser === browser)
            .map((source) => source.profile)
            .join(", ")}`,
        })),
        { date: new Date(entry.last), tooltip: `${entry.visits} visits` },
      ]}
      actions={
        <ActionPanel>
          <Action
            title="Copy URL"
            icon={Icon.Clipboard}
            onAction={() => copy(() => entry.url, onUse)}
          />
          <Action.Paste
            title="Paste URL"
            content={entry.url}
            shortcut={{ modifiers: ["shift"], key: "return" }}
            onPaste={onUse}
          />
          <Action
            title="Copy as Markdown Link"
            icon={Icon.Clipboard}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
            onAction={() => copy(() => markdownLink(entry), onUse)}
          />
          {/* shortcut: the browser opens the URL in the profile it used last, not in the
              profile of the visit. Upgrade: start the browser binary with --profile-directory. */}
          {browsers.map((browser, i) => (
            <Action.Open
              key={browser}
              title={`Open in ${BROWSERS[browser].title}`}
              target={entry.url}
              application={BROWSERS[browser].app}
              icon={{ fileIcon: app(browser) }}
              shortcut={i === 0 ? { modifiers: ["cmd"], key: "o" } : undefined}
              onOpen={onUse}
            />
          ))}
          {listActions}
        </ActionPanel>
      }
    />
  );
}
