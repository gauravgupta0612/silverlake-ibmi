# Vanthrex for IBM i

[![CI](https://github.com/gauravgupta0612/silverlake-ibmi/actions/workflows/ci.yml/badge.svg)](https://github.com/gauravgupta0612/silverlake-ibmi/actions/workflows/ci.yml)

An all-in-one IBM i workbench for VS Code, built to be easy for first-time users. Connect with a guided form, browse libraries and the IFS, edit and compile with inline errors, run Db2 for i SQL in a sortable grid, read spooled files and get help writing RPG, all from one sidebar.

> 📖 **Documentation:** [https://gauravgupta0612.github.io/vanthrex-ibmi-docs/](https://gauravgupta0612.github.io/vanthrex-ibmi-docs/) — installation, setup, every feature, commands, settings, troubleshooting and FAQ ([docs repository](https://github.com/gauravgupta0612/vanthrex-ibmi-docs)).
>
> 📘 New here? Read the **[Feature Guide](FEATURES.md)** for why and how to use every feature.

> **Vanthrex** = *vanguard* + *T-Rex*: a powerful, modern workbench for one of the most dependable platforms.

[![Docs](https://img.shields.io/badge/docs-online-blue)](https://gauravgupta0612.github.io/vanthrex-ibmi-docs/) [![Marketplace](https://img.shields.io/visual-studio-marketplace/v/gauravgupta0612.vanthrex-ibmi?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=gauravgupta0612.vanthrex-ibmi)

## Highlights

| Area | What you get |
|---|---|
| **Connect** | Guided form with **Test connection**, SSH password or key, passwords in the VS Code secret store, status-bar quick menu (`Ctrl+Alt+I`), optional auto-reconnect. |
| **Browse** | *Libraries & Source* (source files, members, objects), *IFS Browser*, *My Spooled Files*. Find a member by pattern across your library list. |
| **Edit** | Members and IFS files open like local files; `Ctrl+S` saves to the IBM i. New RPG and CL members start from a template that compiles as-is. |
| **Compile** | `Ctrl+Alt+C`. The command is chosen from the source type, you pick once when several fit, and errors from EVFEVENT appear inline and in *Problems*. |
| **SQL** | `Ctrl+Enter` runs the statement under the cursor. Results grid with sort, filter, copy and CSV export. Confirmation before destructive statements. `ibmi-…` snippets for IBM i Services. |
| **CL** | `Ctrl+Alt+L` runs a CL command with your library list and keeps a history. |
| **Spool** | Open, save or delete your spooled files. |
| **RPG** | Highlighting for free and fixed format, outline and breadcrumbs, hovers for BIFs and opcodes, **column hints on fixed-format specs**, `%` completion, snippets, and **fixed C-spec → free** conversion. |
| **CL / DDS** | Syntax highlighting and snippets. |
| **System dashboard** *(new)* | CPU, system ASP, jobs, memory, top CPU jobs, latest QSYSOPR messages and PTF group levels, refreshing automatically. |
| **Jobs & messages** *(new)* | *Active Jobs* view (yours, a user, a subsystem or all): job log, hold, release, end. *Messages* view for QSYSOPR and your own queue: messages waiting for an answer come first and you reply in two clicks. |
| **Table data editor** *(new)* | Open any physical file or table in a grid: filter with a WHERE clause, page through rows, edit cells, add and delete rows. Values are checked against the column type before anything is written. |
| **Object & source search** *(new)* | `Ctrl+Alt+O` finds objects by name or text across your library list or all user libraries. `Ctrl+Alt+F` searches the source code of members. **Where used** lists the programs that reference a file or program. **Open program source** jumps from a *PGM to the member it was compiled from. |
| **RPG navigation** *(new)* | Go to definition (F12, also into /COPY members), find all references, rename (F2, scoped to the procedure), highlight occurrences, Ctrl+click on /COPY and /INCLUDE, and hover a name to see its declaration. |
| **SQL autocomplete** *(new)* | Table and view names after FROM/JOIN/INTO/UPDATE, columns after `alias.`, columns of the tables in your statement, and hover for column types and descriptions. |
| **Local history & compare** *(new)* | Every member and IFS file you open or save is kept locally. Compare any version, restore it, compare your editor with the copy on the IBM i, or compare two members side by side. |
| **SEU-style source dates** *(new in 0.3)* | Each line shows its last-changed date (and sequence number), dates of untouched lines are kept on save, and you can highlight lines changed since any date. |
| **F4 prompters** *(new in 0.3)* | F4 on a fixed-format RPG or DDS line opens a labelled form for its columns. F4 on a CL command builds a form from the command's real definition. |
| **Locks & conflicts** *(new in 0.3)* | Shows who has a member open (name, job, lock) right in the editor, lets you ask them to release it or get notified when it's free, and warns before you overwrite changes made by someone else. |
| **RPG code checks** *(new)* | As you type: unused variables, GOTO, missing *INLR/RETURN, empty ON-ERROR, SELECT *, numbered indicators, overly long procedures and fixed/free mixing. Each check can be turned off, with quick fixes where possible. |

## Requirements on the IBM i

- **SSH server** running: `STRTCPSVR SERVER(*SSHD)`. The user profile needs a home directory (e.g. `/home/MYUSER`).
- **SQL**, one of these (the *Automatic* setting tries them in order):
  1. **Mapepire over SSH**, which needs nothing installed beyond **Java** (5770-JV1). Vanthrex uploads the Mapepire server JAR to `~/.mapepire` on first use and runs it over your SSH session.
  2. **Mapepire daemon**, if you already run one (port 8076).
  3. **db2util** (`yum install db2util`).

## Install

- **From the Marketplace:** in VS Code, open **Extensions** (Ctrl+Shift+X), search for **Vanthrex for IBM i** and click **Install**.
- **Offline:** download the `.vsix` from [Releases](https://github.com/gauravgupta0612/silverlake-ibmi/releases), then **Extensions** → `…` → **Install from VSIX…**.

Then click the Vanthrex icon in the activity bar, then **Add IBM i Connection**.

## Build from source

```bash
npm install
npm run typecheck
npm test            # unit tests for the parsers and the RPG converter
npm run package     # creates vanthrex-ibmi-<version>.vsix
```

Press `F5` to start an Extension Development Host (launch settings are in `.vscode/`).

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `vanthrex.compileActions` | RPG/SQLRPG/CL/DDS/CMD/SQL, member and IFS | Compile commands. Variables: `&LIB &OBJLIB &SRCFILE &NAME &EXT &FULLPATH &CURLIB &USER`. |
| `vanthrex.sql.maxRows` | 500 | Rows fetched into the grid. |
| `vanthrex.sql.confirmDestructive` | true | Ask before DROP / TRUNCATE / DELETE or UPDATE without WHERE. |
| `vanthrex.tempDirectory` | `/tmp` | IFS folder for temporary transfer files. |
| `vanthrex.spool.maxEntries` | 200 | Spooled files listed. |
| `vanthrex.autoConnectLast` | false | Reconnect at start-up. |
| `vanthrex.objects.showAll` | true | Show the *Objects* folder under libraries. |
| `vanthrex.dashboard.refreshSeconds` | 30 | Dashboard refresh interval (0 = manual). |
| `vanthrex.dataEditor.pageSize` | 100 | Rows per page in the table data editor. |
| `vanthrex.history.enabled` / `maxVersions` | true / 50 | Local history of members and IFS files. |
| `vanthrex.lint.enabled` / `rules` / `maxProcedureLines` | true / all on / 200 | RPG code checks. |

## How it works

- Members are transferred with `CPYTOSTMF` / `CPYFRMSTMF` in CCSID 1208, so national characters survive the round trip. Lines longer than the source file's record length are truncated by the system. With a Mapepire SQL engine, members are read and saved through SQL with their sequence numbers and dates (SRCSEQ / SRCDAT) instead, like SEU.
- CL commands run in a QSH job whose library list comes from the connection (`liblist`), then `system`.
- Compile errors are read from `&OBJLIB/EVFEVENT(&NAME)`. For SQLRPGLE, errors that RPG reports on the precompiled source are shown on line 1 with the generated line number.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+Alt+I` | IBM i quick menu |
| `Ctrl+Alt+C` | Compile |
| `Ctrl+Enter` | Run SQL statement (in .sql files) |
| `Ctrl+Alt+L` | Run CL command |
| `Ctrl+Alt+O` | Search objects |
| `Ctrl+Alt+F` | Search source code |
| `F12` / `Shift+F12` / `F2` | RPG: go to definition / references / rename |
| `F4` | Prompt the fixed-format spec (RPG, DDS) or CL command at the cursor |
| `Ctrl+Alt+D` | Cycle source dates: date → sequence + date → hidden |

## Known limitations (v0.3)

- **Where used** builds its cross-reference with DSPPGMREF in QTEMP, so it needs a Mapepire SQL engine (not db2util). Scanning large libraries takes a while.
- The table data editor writes each change straight away (no commitment control). Rows are identified by relative record number, so don't reorganize a file while editing it.
- Source dates and the conflict checks need a Mapepire SQL engine. With db2util, members are copied as plain text (dates are reset on save, as before).
- Rename only works inside one source and refuses length changes in fixed-format sources, because they would shift columns.

- One active connection at a time.
- The fixed → free converter handles C-specs only (H/F/D specs are left as they are). Anything it can't convert safely is marked `// TODO`.
- Interactive (5250) commands such as `WRKACTJOB` can't run from the CL runner; use their `OUTPUT(*PRINT)` form or the IBM i Services SQL snippets.
