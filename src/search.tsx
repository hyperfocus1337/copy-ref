import { List } from "@raycast/api";
import { useState } from "react";
import { useHistoryView } from "./history-list";
import { usePathView } from "./path-list";
import { useSessionView } from "./session-list";
import { type View, ViewDropdown, readDraft, writeDraft } from "./views";

// The view of every search command. One List and one dropdown show all views, so a switch
// keeps the search text. A new List.Dropdown would not follow its value: Raycast applies a
// value only when the count of dropdown changes of the extension matches its own, and a new
// dropdown starts its count at 0. Each view hook gives the rows of its view and loads only
// while its view shows; the path index builds once per open, so a path view opens at once.
export function Search({ initialView }: { initialView: View }) {
  const [view, setView] = useState(initialView);
  const [searchText, setText] = useState(readDraft);
  const setSearchText = (text: string) => {
    setText(text);
    writeDraft(text);
  };
  const props = { view, setView, searchText };
  const isPath = view !== "url" && view !== "session";
  const paths = usePathView({ ...props, active: isPath, kind: isPath ? view : "all" });
  const history = useHistoryView({ ...props, active: view === "url" });
  const sessions = useSessionView({ ...props, active: view === "session" });
  const shown = view === "url" ? history : view === "session" ? sessions : paths;
  return (
    <List
      isLoading={shown.isLoading}
      searchText={searchText}
      onSearchTextChange={setSearchText}
      throttle
      searchBarPlaceholder={shown.placeholder}
      searchBarAccessory={<ViewDropdown view={view} setView={setView} />}
    >
      {shown.children}
    </List>
  );
}
