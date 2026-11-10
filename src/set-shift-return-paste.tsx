import { Action, ActionPanel, Color, Icon, List, showHUD } from "@raycast/api";
import { useLocalStorage } from "@raycast/utils";
import { DEFAULT_PASTE, PASTE_KEY, PASTE_TITLES, type PasteKind, toPasteKind } from "./paths";

export default function Command() {
  const { value: stored, setValue, isLoading } = useLocalStorage<string>(PASTE_KEY, DEFAULT_PASTE);
  const paste = toPasteKind(stored);

  // The list opens on the current choice, so Return keeps it.
  return (
    <List isLoading={isLoading} selectedItemId={isLoading ? undefined : paste}>
      {(Object.entries(PASTE_TITLES) as [PasteKind, string][]).map(([kind, title]) => (
        <List.Item
          key={kind}
          id={kind}
          title={title}
          icon={kind === paste ? { source: Icon.CheckCircle, tintColor: Color.Green } : Icon.Circle}
          actions={
            <ActionPanel>
              <Action
                title={`Paste ${title} on Shift+Return`}
                icon={Icon.CheckCircle}
                onAction={async () => {
                  await setValue(kind);
                  await showHUD(`Shift+Return pastes the ${title.toLowerCase()}`);
                }}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
