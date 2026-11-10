import {
  Action,
  ActionPanel,
  Color,
  Form,
  Icon,
  List,
  confirmAlert,
  useNavigation,
} from "@raycast/api";
import { useLocalStorage } from "@raycast/utils";
import { type ReactNode, useState } from "react";
import {
  DEFAULT_EXCLUSIONS,
  DEFAULT_SETTINGS,
  type Exclusion,
  SETTINGS_KEY,
  type Settings,
  withNewDefaults,
} from "./paths";

export default function Command() {
  const {
    value: stored = DEFAULT_SETTINGS,
    setValue,
    isLoading,
  } = useLocalStorage<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS);
  const settings = withNewDefaults(stored);
  const update = (change: Partial<Settings>) => setValue({ ...settings, ...change });
  const setExclusions = (exclusions: Exclusion[]) => update({ exclusions });
  const exclusions = settings.exclusions;

  const listActions = (
    <>
      <Action.Push
        title="Add Pattern"
        icon={Icon.Plus}
        shortcut={{ modifiers: ["cmd"], key: "n" }}
        target={
          <AddPatternForm
            existing={exclusions.map((item) => item.pattern)}
            onAdd={(pattern) => setExclusions([...exclusions, { pattern, on: true }])}
          />
        }
      />
      <Action
        title="Reset Exclusions to Defaults"
        icon={Icon.ArrowCounterClockwise}
        onAction={async () => {
          const confirmed = await confirmAlert({
            title: "Reset the exclusions?",
            message: "This deletes your own patterns and turns each default pattern on.",
          });
          if (confirmed) setExclusions(DEFAULT_EXCLUSIONS);
        }}
      />
    </>
  );

  const on = exclusions.filter((item) => item.on).length;
  return (
    <List isLoading={isLoading} searchBarPlaceholder="Filter exclusions">
      <List.Section title="Index">
        <ToggleItem
          title="Include hidden files"
          subtitle="Names that start with a dot"
          on={settings.includeHidden}
          labels={["On", "Off"]}
          onToggle={() => update({ includeHidden: !settings.includeHidden })}
          actions={listActions}
        />
        <ToggleItem
          title="Include gitignored files"
          subtitle="Files that .gitignore excludes"
          on={settings.includeIgnored}
          labels={["On", "Off"]}
          onToggle={() => update({ includeIgnored: !settings.includeIgnored })}
          actions={listActions}
        />
      </List.Section>
      <List.Section title="Exclusions" subtitle={`${on} of ${exclusions.length} on`}>
        {exclusions.map((item) => (
          <ToggleItem
            key={item.pattern}
            title={item.pattern}
            on={item.on}
            labels={["Excluded", "Included"]}
            onToggle={() =>
              setExclusions(
                exclusions.map((other) => (other === item ? { ...other, on: !other.on } : other)),
              )
            }
            actions={
              <>
                {listActions}
                <Action
                  title="Delete Pattern"
                  icon={Icon.Trash}
                  style={Action.Style.Destructive}
                  shortcut={{ modifiers: ["ctrl"], key: "x" }}
                  onAction={() => setExclusions(exclusions.filter((other) => other !== item))}
                />
              </>
            }
          />
        ))}
      </List.Section>
    </List>
  );
}

function ToggleItem({
  title,
  subtitle,
  on,
  labels,
  onToggle,
  actions,
}: {
  title: string;
  subtitle?: string;
  on: boolean;
  labels: [string, string];
  onToggle: () => void;
  actions: ReactNode;
}) {
  return (
    <List.Item
      title={title}
      subtitle={subtitle}
      icon={on ? { source: Icon.CheckCircle, tintColor: Color.Green } : Icon.Circle}
      accessories={[{ text: on ? labels[0] : labels[1] }]}
      actions={
        <ActionPanel>
          <Action
            title={on ? "Turn Off" : "Turn On"}
            icon={on ? Icon.Circle : Icon.CheckCircle}
            onAction={onToggle}
          />
          {actions}
        </ActionPanel>
      }
    />
  );
}

function AddPatternForm({
  existing,
  onAdd,
}: {
  existing: string[];
  onAdd: (pattern: string) => void;
}) {
  const { pop } = useNavigation();
  const [error, setError] = useState<string>();
  return (
    <Form
      actions={
        <ActionPanel>
          <Action.SubmitForm
            title="Add Pattern"
            onSubmit={({ pattern }: { pattern: string }) => {
              const value = pattern.trim();
              if (value === "") setError("Enter a pattern");
              else if (existing.includes(value)) setError("The list already has this pattern");
              else {
                onAdd(value);
                pop();
              }
            }}
          />
        </ActionPanel>
      }
    >
      <Form.TextField
        id="pattern"
        title="Pattern"
        placeholder="*.tmp"
        error={error}
        onChange={() => setError(undefined)}
      />
      <Form.Description text="node_modules excludes a file or folder with this name at any depth. /Library excludes it only at the top of a root folder. *.tmp excludes names that end in .tmp." />
    </Form>
  );
}
