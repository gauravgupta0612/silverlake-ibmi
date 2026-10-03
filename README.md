# Silverlake for IBM i

[![CI](https://github.com/gauravgupta0612/silverlake-ibmi/actions/workflows/ci.yml/badge.svg)](https://github.com/gauravgupta0612/silverlake-ibmi/actions/workflows/ci.yml)

An all-in-one IBM i workbench for VS Code, built to be easy for first-time users. Connect with a guided form, browse libraries and the IFS, edit and compile with inline errors, run Db2 for i SQL in a sortable grid, read spooled files and get help writing RPG, all from one sidebar.

> 📘 New here? Read the **[Feature Guide](FEATURES.md)** for why and how to use every feature.

> The name comes from *Silverlake*, the codename of the original AS/400 project.

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
| **RPG code checks** *(new)* | As you type: unused variables, GOTO, missing *INLR/RETURN, empty ON-ERROR, SELECT *, numbered indicators, overly long procedures and fixed/free mixing. Each check can be turned off, with quick fixes where possible. |

## Requirements on the IBM i

- **SSH server** running: `STRTCPSVR SERVER(*SSHD)`. The user profile needs a home directory (e.g. `/home/MYUSER`).
- **SQL**, one of these (the *Automatic* setting tries them in order):
  1. **Mapepire over SSH**, which needs nothing installed beyond **Java** (5770-JV1). Silverlake uploads the Mapepire server JAR to `~/.mapepire` on first use and runs it over your SSH session.
  2. **Mapepire daemon**, if you already run one (port 8076).
  3. **db2util** (`yum install db2util`).

## Install

1. Download the latest `.vsix` from [Releases](https://github.com/gauravgupta0612/silverlake-ibmi/releases).
2. In VS Code, open **Extensions** → `…` → **Install from VSIX…** and pick the file.
3. Click the Silverlake icon in the activity bar, then **Add IBM i Connection**.

## Build from source

```bash
npm install
npm run typecheck
npm test            # unit tests for the parsers and the RPG converter
npm run package     # creates silverlake-ibmi-<version>.vsix
```

Press `F5` to start an Extension Development Host (launch settings are in `.vscode/`).

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `silverlake.compileActions` | RPG/SQLRPG/CL/DDS/CMD/SQL, member and IFS | Compile commands. Variables: `&LIB &OBJLIB &SRCFILE &NAME &EXT &FULLPATH &CURLIB &USER`. |
| `silverlake.sql.maxRows` | 500 | Rows fetched into the grid. |
| `silverlake.sql.confirmDestructive` | true | Ask before DROP / TRUNCATE / DELETE or UPDATE without WHERE. |
| `silverlake.tempDirectory` | `/tmp` | IFS folder for temporary transfer files. |
| `silverlake.spool.maxEntries` | 200 | Spooled files listed. |
| `silverlake.autoConnectLast` | false | Reconnect at start-up. |
| `silverlake.objects.showAll` | true | Show the *Objects* folder under libraries. |
| `silverlake.dashboard.refreshSeconds` | 30 | Dashboard refresh interval (0 = manual). |
| `silverlake.dataEditor.pageSize` | 100 | Rows per page in the table data editor. |
| `silverlake.history.enabled` / `maxVersions` | true / 50 | Local history of members and IFS files. |
| `silverlake.lint.enabled` / `rules` / `maxProcedureLines` | true / all on / 200 | RPG code checks. |

## How it works

- Members are transferred with `CPYTOSTMF` / `CPYFRMSTMF` in CCSID 1208, so national characters survive the round trip. Lines longer than the source file's record length are truncated by the system. Saving a member resets its source dates (SRCDAT).
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

## Known limitations (v0.2)

- **Where used** builds its cross-reference with DSPPGMREF in QTEMP, so it needs a Mapepire SQL engine (not db2util). Scanning large libraries takes a while.
- The table data editor writes each change straight away (no commitment control). Rows are identified by relative record number, so don't reorganize a file while editing it.
- Rename only works inside one source and refuses length changes in fixed-format sources, because they would shift columns.

- One active connection at a time.
- The fixed → free converter handles C-specs only (H/F/D specs are left as they are). Anything it can't convert safely is marked `// TODO`.
- Interactive (5250) commands such as `WRKACTJOB` can't run from the CL runner; use their `OUTPUT(*PRINT)` form or the IBM i Services SQL snippets.
