import { Action, ActionPanel, Color, Form, Icon, List, useNavigation } from "@raycast/api";
import { useLocalStorage } from "@raycast/utils";
import { existsSync } from "node:fs";
import {
  DEFAULT_SETTINGS,
  SETTINGS_KEY,
  type Settings,
  expandTilde,
  tildePath,
  withNewDefaults,
} from "./paths";

export default function Command() {
  const {
    value: stored = DEFAULT_SETTINGS,
    setValue,
    isLoading,
  } = useLocalStorage<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS);
  const settings = withNewDefaults(stored);
  const setRoots = (roots: string[]) => setValue({ ...settings, roots });

  const addAction = (
    <Action.Push
      title="Add Folders"
      icon={Icon.Plus}
      shortcut={{ modifiers: ["cmd"], key: "n" }}
      target={
        <AddFoldersForm
          onAdd={(folders) =>
            setRoots([...new Set([...settings.roots, ...folders.map(tildePath)])])
          }
        />
      }
    />
  );

  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter root folders">
      <List.EmptyView
        title="No root folders"
        description="Add a folder with ⌘N"
        actions={<ActionPanel>{addAction}</ActionPanel>}
      />
      {settings.roots.map((root) => (
        <List.Item
          key={root}
          title={root}
          icon={Icon.Folder}
          // A missing root stops the index build, so the old index stays.
          accessories={
            existsSync(expandTilde(root)) ? [] : [{ tag: { value: "Missing", color: Color.Red } }]
          }
          actions={
            <ActionPanel>
              {addAction}
              <Action.ShowInFinder path={expandTilde(root)} />
              <Action
                title="Remove Folder"
                icon={Icon.Trash}
                style={Action.Style.Destructive}
                shortcut={{ modifiers: ["ctrl"], key: "x" }}
                onAction={() => setRoots(settings.roots.filter((item) => item !== root))}
              />
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}

function AddFoldersForm({ onAdd }: { onAdd: (folders: string[]) => void }) {
  const { pop } = useNavigation();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Add Folders"
            onSubmit={({ folders }: { folders: string[] }) => {
              onAdd(folders);
              pop();
            }}
          />
        </ActionPanel>
      }
    >
      <Form.FilePicker
        id="folders"
        title="Folders"
        canChooseDirectories
        canChooseFiles={false}
        allowMultipleSelection
      />
    </Form>
  );
}
