# Copy Ref

A Raycast extension that searches files, folders, browser history and agent sessions, and copies a path, a URL or a session name.

## Requirements

- `fd` and `fzf`, from Homebrew. Raycast starts an extension with a minimal `PATH`, so the extension adds `/opt/homebrew/bin` and `/usr/local/bin`.
- `/usr/bin/sqlite3` for the browser history, and on macOS 27 the Files & Folders permission of Raycast for Brave Browser and Microsoft Edge.
- `pnpm` to install and build the extension: `pnpm install && pnpm dev` runs `ray develop`, which adds the extension to Raycast.
- `rg` for the agent sessions, on the host and in each container, and `docker` for the containers. The cmux titles use the CLI in `/Applications/cmux.app`.

## Commands

| Command                | What it does                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| Copy Paths             | Fuzzy search the files and folders under the root folders, and copy or paste the path of a result |
| Copy File Paths        | Copy Paths, with only files                                                                       |
| Copy Folder Paths      | Copy Paths, with only folders                                                                     |
| Copy Browser URLs      | Search the history of all Edge and Brave profiles, and copy a URL                                 |
| Copy Agent Sessions    | Search the claude, codex, pi and omp sessions on the host and in the containers, and copy a name  |
| Manage Root Folders    | Add and remove the folders to search. ⌘⇧R in a search list opens it                               |
| Manage Exclusions      | Turn patterns on and off, add and delete them, and set hidden and gitignored files. ⌘⇧E opens it  |
| Set Shift+Return Paste | Choose what ⇧⏎ pastes in a search list: a path, the name, or a devcontainer path                  |

The extension preferences choose the browsers and the number of days of history to search, 90 by default. The Compose File preference gives the devcontainer path: a Docker Compose file whose short-form volumes, such as `- ~/code:/workspaces/code`, mount host folders under `/workspaces`. With no Compose File, there is no devcontainer path. The session preferences are in [Agent sessions](#agent-sessions).

## Keys on a path

The HUD shows the copied text. When there is nothing to copy, a failure toast gives the reason.

| Key | Copies                                                                 |
| --- | ---------------------------------------------------------------------- |
| ⏎   | The `~/` path, or the absolute path outside the home folder            |
| ⌘⏎  | The path relative to the git repository, `.` for the repository folder |
| ⇧⏎  | Pastes the choice of Set Shift+Return Paste                            |
| ⌘D  | The path in the devcontainer, from the mounts of the compose file      |
| ⌘-  | The folder that holds a file, or the folder itself                     |
| ⌘N  | The name                                                               |
| ⌘R  | The name of the repository                                             |
| ⌘F  | The text of the file, up to 1 MB and not for a binary file             |
| ⌘G  | The link to the file on its branch on the `origin` remote              |
| ⇧⌘G | The same link, pinned to the `HEAD` commit                             |
| ⇧⌘W | The homepage of the repository                                         |

github.com gets GitHub links, with `/blob/` for a file and `/tree/` for a folder. Every other host gets GitLab links, with `/-/blob/` and `/-/tree/`. `ssh -G` gives the real host of an SSH alias, so `work.gitlab.com` gives gitlab.com.

## Recent paths and the search type

With an empty search, the list shows the paths of its type from the 30 paths you used last, in all three path commands. ⌃X removes a path from that list and ⌃⇧X clears it. Each open builds the index again in the background.

To change the type of a search, keep the text and switch in one of two ways:

- In the open command: ⌘⇧F shows files, ⌘⇧D folders, ⌘⇧A both, ⌘⇧U the browser history, and ⌘⇧S the agent sessions. The dropdown in the search bar does the same.
- With the hotkey of another command: each command saves its search text, and the next command you open within 30 s starts with it. A copy or paste clears the saved text.

## Agent sessions

Copy Agent Sessions, or ⌘⇧S in any search list, lists the sessions of claude, codex, pi and omp, newest first. One shell script finds the logs of each agent and reads only the lines with the id, the folder, a name, a title or the first prompt. It runs on the host, and through `docker exec` in each container of the preferences, because the container logs are in Docker volumes. The list shows the sessions of the last read at once and reads them again on each open. Subagent sessions of Claude Code are not in the list.

| Session data | claude                     | codex                                  | pi                       | omp                     |
| ------------ | -------------------------- | -------------------------------------- | ------------------------ | ----------------------- |
| Logs         | `~/.claude/projects`       | `~/.codex/sessions`                    | `~/.pi/agent/sessions`   | `~/.omp/agent/sessions` |
| Set name     | `/rename` (`custom-title`) | `thread_name` in `session_index.jsonl` | `/name` (`session_info`) |                         |
| Agent title  | `ai-title`                 |                                        |                          | `title`                 |

The first prompt as a name is one line of at most 120 characters. Codex does not tell a name that you set from one it made, so its `thread_name` counts as a set name.

A session whose agent runs in a cmux terminal also has a cmux title: the title of that terminal. `cmux sessions list --json --all` gives the terminal of each session, and `cmux --json tree --all` the title of each terminal. A Pi session in a container gets its terminal from the files of the host bridge in `~/.local/state/agent-cmux`.

A session has a cmux title only while cmux sees its agent process, because a terminal whose agent ended shows the title of its shell. For the same reason, a recent session does not keep its cmux title. When cmux does not run, no session has one.

| Key | Copies                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------ |
| ⏎   | The name                                                                                                                 |
| ⌘⏎  | The session id                                                                                                           |
| ⌘R  | The resume command: `cd <folder> && claude --resume <id>` on the host, `cas resume <agent> <id> <folder>` in a container |
| ⌘-  | The folder of the session, as a host path when a bind mount holds it, else the path in the container                     |
| ⇧⏎  | Pastes the name                                                                                                          |

On the host, the resume commands are `claude --resume`, `codex resume`, `pi --session` and `omp --resume`. The command starts with a `cd`, because pi looks for the id among the sessions of its folder.

| Preference           | Default                                                        | What it does                                                                                                                                                                                                                                                                                           |
| -------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session Containers   |                                                                | The containers to read, separated by commas. `name=label` sets the label that the list shows                                                                                                                                                                                                           |
| Container User       |                                                                | The user of `docker exec`. Empty uses the default user of the container                                                                                                                                                                                                                                |
| Session Days         | 14                                                             | Show the sessions whose log changed in the last number of days. 0 shows all                                                                                                                                                                                                                            |
| Session Name         | Set name, else cmux title, else agent title, else first prompt | The text that shows and copies as the name. The other 6 choices keep this order and drop one or more sources after the set name. The cmux title is never the last source: it goes when the agent ends, and a session without a name is not in the list. A session with no such text is not in the list |
| Empty Session Search | Newest sessions                                                | With an empty search, show the newest sessions, or the 30 sessions you copied last. ⌃X and ⌃⇧X edit that list                                                                                                                                                                                          |

A container that is not running gives a failure toast, and the other sessions still show.

## Code

Each view is its own module with a view hook that gives the rows of the view. `src/search.tsx` shows the rows of the selected view in one List with one dropdown. A List per view would break the dropdown: Raycast applies a dropdown value only when the count of dropdown changes of the extension matches its own, and a new dropdown starts its count at 0.

| View            | View hook              | Data              |
| --------------- | ---------------------- | ----------------- |
| Files, folders  | `src/path-list.tsx`    | `src/paths.ts`    |
| Browser history | `src/history-list.tsx` | `src/history.ts`  |
| Agent sessions  | `src/session-list.tsx` | `src/sessions.ts` |

`src/views.tsx` holds the view keys, the dropdown, the search text draft and the copy helper that all lists share. The data modules import only Node modules, so the tests run them without Raycast.

## Default settings

The two Manage commands keep their settings in Raycast storage. A new Mac starts with these defaults:

- Root folders: `~`.
- Hidden files and gitignored files: both off.
- Exclusions, all on: `/Library`, `/OrbStack`, `node_modules`, `.venv`, `venv`, `vendor`, `.git`, `__pycache__`, `.mypy_cache`, `.pytest_cache`, `dist`, `build`, `target`, `.next`, `coverage`, `.cache`, `.terraform`. A pattern that starts with `/` matches only at the top of a root folder. Reset Exclusions to Defaults in Manage Exclusions restores this list.

With the defaults, `~` has 236,000 entries and takes 0.9 s to index. With no exclusions, `~` has 3.0 million entries and takes 31 s: `~/Library` has 1.6 million and `~/OrbStack` 1.1 million.

## Raycast shortcut limits

- Raycast reserves ⌘W, ⌘P, ⌘K and ⌘Esc. It drops these shortcuts from an action and warns only while `ray develop` runs.
- The second action gets ⌘⏎ only when it has no shortcut of its own. With one, Raycast shows that shortcut and no ⌘⏎.

## Test

```bash
pnpm install && pnpm test
```
