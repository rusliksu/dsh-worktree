# dsh-worktree

A Git worktree plugin for DeepSeek Harness that creates task branches, registers worktrees as DSH Workspaces, and opens isolated sessions.

> npm package: `@alpacachen/dsh-simple-worktree`

[![npm version](https://img.shields.io/npm/v/@alpacachen/dsh-simple-worktree?color=5b8def&label=npm)](https://www.npmjs.com/package/@alpacachen/dsh-simple-worktree)
![DeepSeek Harness Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-7c5cff)
[![Awesome DSH Plugin](https://awesome-dsh-plugin.com/badge.svg)](https://awesome-dsh-plugin.com)
![License](https://img.shields.io/badge/license-MIT-22c55e)

[Simplified Chinese](README.zh.md) · **English**

![Create a worktree from a new DSH session](docs/preview.png)

## Features

- Create a Git worktree from the new-session action in any Git Workspace.
- Choose the current branch or the repository's main branch.
- Register and open the new worktree as a DSH Workspace with an isolated session.
- Create task branches as `task/<name>`.
- Inspect and open linked worktrees from the **Worktree Management** settings page.
- No additional service or project configuration.
- Supports DSH themes, Russian, Chinese, and English.

## Compatibility

This Desktop fork is built and tested against DSH **0.2.1-rc.2** (web and desktop profiles). It adds Russian UI and an optional managed Windows helper. Removal is disabled; see [the Russian guide](README.ru.md) for creation policy and installation.

## Usage

### Install

```sh
dsh plugin --profile web add @alpacachen/dsh-simple-worktree
```

Restart `dsh web` after installation.

In the desktop app, install the package from **Plugins → Add plugin**, enable it, and restart the app and host.

You can also install from GitHub with `dsh plugin --profile web add github:alpacachen/dsh-worktree`.

### Create from a new session

1. Open **New Session** in a Git Workspace.
2. Choose **Create worktree** above the composer.
3. Enter a task name. The repository's main branch is selected by default.
4. Click **Create and open**.

### Manage worktrees

Open **Settings → Worktree Management** to find Git projects and linked worktrees, inspect their branch and dirty state, and open a session. Select a specific Workspace when a broad home-directory scan reaches its limit. This Desktop build disables removal and pruning until a separate preservation review is performed.

Choose **Git changes** beside a repository or worktree to inspect tracked-file patches from the working tree, staging area, or committed branch changes since the merge base. The viewer does not change files, the index or branches, and disables external diff/textconv helpers. Untracked files appear after `git add`; renames are displayed as deletion plus addition. Credential files remain path-only and binary files show a difference notice. Comparisons exceeding 500 files or 256 KiB of output are rejected rather than shown partially.

The worktree is created at:

```text
project.worktrees/login-fix/
└── branch: task/login-fix
```

The new Workspace is named `<parent>/<task>`. Removing the worktree Workspace does not delete its Git branch.
