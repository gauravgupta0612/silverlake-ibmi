# Vanthrex for IBM i — Feature Guide

> The full, searchable documentation is at **https://gauravgupta0612.github.io/vanthrex-ibmi-docs/**

> **One sidebar for everything you do on IBM i:** connect, browse, edit, compile, query, monitor and fix — without leaving VS Code and without a green screen.

---

## Why this extension is useful

IBM i development usually means switching between several tools:

| Task | Traditional way | With Vanthrex |
|---|---|---|
| Edit source | SEU / PDM in a 5250 session | VS Code editor with colours, outline, F12 / F2 |
| Compile | `WRKMBRPDM` option 14, then read the spool file for errors | **Ctrl+Alt+C** → errors underlined on the right line |
| Run SQL | STRSQL or a separate SQL client | **Ctrl+Enter** → sortable grid, CSV export, autocomplete |
| Look at data | UPDDTA / DFU / a query | **Edit Table Data** grid |
| Check the system | WRKACTJOB, WRKSYSSTS, DSPMSG QSYSOPR | **System Dashboard**, *Active Jobs* and *Messages* views |
| Find code | `FNDSTRPDM`, DSPPGMREF printouts | **Ctrl+Alt+F**, **Ctrl+Alt+O**, **Where Used** |
| Undo a mistake | Hope someone kept a backup | **Local History** on every open and save |
| See what changed when | SEU date column | **Source dates** in front of every line, kept on save |
| Someone else has the member | "Member in use" error, then WRKOBJLCK | **Lock banner** with the person's name and *Ask to release* |

Vanthrex puts all of this in one place. It is built for people who are **new to IBM i** (guided forms, templates, plain-language messages) as well as **experienced developers** who want speed and modern tooling.

## Why it is powerful

- **Nothing to install on the IBM i.** It only needs SSH. Fast SQL ("Mapepire") is uploaded and started automatically, and needs only Java, which IBM i already has.
- **Safe by default.**
  - It asks before risky SQL (DROP, DELETE without WHERE).
  - It asks before deleting objects or ending jobs, and before writing table data.
  - Passwords go in the VS Code secret store, never in settings files.
- **Never lose work.** Every member you open or save is copied locally, so you can compare and restore any version.
- **Understands RPG.** It knows declarations, procedures, /COPY members and fixed-format columns, so navigation, rename and checks work on real code.
- **Clear when something goes wrong.** Errors appear inline or as clear messages, and every command sent to the IBM i is written to an output log you can read.
- **Configurable.** Compile commands, checks, page sizes and refresh times are all ordinary VS Code settings.

---

## Getting started (5 minutes)

1. **Install:** Extensions view → `…` → **Install from VSIX…** → the `.vsix` from the GitHub **Releases** page.
2. Click the **Vanthrex** icon in the activity bar, then **Add IBM i Connection**.
3. Fill in the host, user and library list, click **Test connection**, then **Save**.
4. Click the connection to connect. The status bar shows the system name. Click it, or press **Ctrl+Alt+I**, at any time for the quick menu.

> On the IBM i, the SSH server must be running: `STRTCPSVR SERVER(*SSHD)`.

---

## Features — what, why and how

### 1. Connection wizard and quick menu

**What:** A one-page form for host, user, sign-in method, library list, current library and SQL engine, with a **Test connection** button.

**Why it helps:** No hand-edited config files. The test tells you straight away whether SSH works and which SQL engine will be used.

**How:**

- **Add IBM i Connection** (the **+** on the *Connections* view).
- Right-click a connection → **Edit** or **Remove**.
- **Ctrl+Alt+I** opens the quick menu: dashboard, run CL, SQL scratchpad, search, edit data, disconnect.

### 2. Libraries & Source browser

**What:** Your library list as a tree. Under each library are its **Source files** and members, and its **Objects** (programs, files, service programs…).

**Why it helps:** It is what PDM does, but with search, icons, descriptions and one-click open.

**How:**

- Click a member to open it, and press **Ctrl+S** to save it back to the IBM i.
- Right-click a library → **New Source File**, **Set as Current Library**, **Remove from List**.
- Right-click a source file → **New Member** (RPG and CL members start from a template that compiles as-is).
- The **search icon** (Find & Open Member) finds a member by name across the library list, with wildcards such as `ORD*`.

### 3. IFS browser

**What:** Browse, open, create and delete stream files and folders.

**How:** Click **Go to IFS Directory** to jump to any path. Right-click a folder → **New File** / **New Folder**.

### 4. One-key compile with inline errors

**What:** **Ctrl+Alt+C** compiles the open member or IFS file with the right command for its type (CRTBNDRPG, CRTSQLRPGI, CRTBNDCL, CRTPF, CRTDSPF…).

**Why it helps:** The compiler's errors land on the exact line and column, and in the Problems panel. You don't read a spool file.

**How:**

- **Ctrl+Alt+C** (or the 🚀 icon in the editor title).
- When several commands fit, choose once and it is remembered. **Compile With…** lets you choose again.
- Add your own commands in *Settings → Vanthrex: Compile Actions*, using variables such as `&LIB`, `&OBJLIB`, `&NAME` and `&SRCFILE`.

### 5. SQL with results grid and autocomplete

**What:** Run Db2 for i SQL from any `.sql` file or the **SQL scratchpad**.

**Why it helps:**

- Results appear in a grid you can sort, filter, copy or export to CSV.
- Table and column names are suggested as you type, and hovering a column shows its type and description.

**How:**

- **New SQL Scratchpad**, put the cursor in a statement, then press **Ctrl+Enter**.
- Type `FROM ` to get table suggestions and `alias.` to get columns.
- Type `ibmi-` for ready-made IBM i Services queries (jobs, job log, locks, PTFs, message queues).

### 6. Table data editor

**What:** A spreadsheet-style editor for any physical file or table.

**Why it helps:**

- It is quicker and safer than DFU or UPDDTA.
- Every value is checked against the column's type and length before anything is written.
- You see a summary and confirm before the changes are saved.

**How:**

- Right-click a file object → **Edit Table Data**, or run the command and type `LIB/FILE`.
- Type a WHERE condition to filter, and use ◀ ▶ to page.
- Click a cell to edit it. Use **+ Row**, **Delete row** and **Set NULL** as needed, then **Save**.

### 7. System dashboard

**What:** A live page showing:

- CPU, system ASP, job counts and memory
- the top jobs by CPU
- the latest QSYSOPR messages
- installed PTF group levels

**Why it helps:** It answers "is the system OK?" in one glance instead of three green-screen commands.

**How:** Click the dashboard icon on the *Connections* view, or use the quick menu. It refreshes every 30 s; change this with `vanthrex.dashboard.refreshSeconds`.

### 8. Active jobs

**What:** A list of your jobs, a user's jobs, a subsystem's jobs, or all active jobs. Jobs in **MSGW** (waiting for a reply) are listed first.

**How:**

- The **filter icon** chooses which jobs to show.
- Click a job to see its **job log**.
- Right-click a job → **Hold**, **Release** or **End Job** (controlled or immediate, with confirmation).

### 9. Messages

**What:** The QSYSOPR queue and your own message queue. Messages that are waiting for an answer have a **?** icon.

**How:**

- Click the reply icon, then pick or type a reply (C, D, I, R, G…).
- Hover a message for its full help text.
- Use **Send Message** to message a user or the system operator.

### 10. Search objects, search source, where used

**What and how:**

- **Ctrl+Alt+O:** find objects by name or description, in your library list, one library or all user libraries. From a result you can open the source, see where it is used, edit data, call the program or copy its name.
- **Ctrl+Alt+F:** search the source code of a library or source file. Click a match to open the member at that line.
- **Where Used** (right-click any object): lists the programs that reference a file or program.
- **Open Program Source:** jumps from a program to the member it was compiled from.

**Why it helps:** Impact analysis before a change, with no printouts.

### 11. RPG navigation

**What and how:**

- **F12** goes to the definition, including definitions inside /COPY members.
- **Shift+F12** finds every use.
- **F2** renames. A local variable is renamed only inside its procedure, and fixed-format columns are protected.
- **Ctrl+click** on a `/COPY` or `/INCLUDE` line opens that member.
- Hovering a name shows its declaration. Hovering a BIF or opcode shows its syntax.
- Hovering a fixed-format line shows which field that column belongs to (Factor 1, Result field…).
- The Outline view lists procedures, subroutines, data structures and prototypes.

### 12. RPG code checks

**What:** Warnings as you type:

- unused variables
- GOTO
- a program with no `*INLR = *ON` or RETURN
- empty ON-ERROR blocks
- `SELECT *`
- numbered indicators
- overly long procedures
- fixed-format code mixed into free format

**Why it helps:** Mistakes are caught before you compile, and team code stays consistent.

**How:**

- Look at the underlined code and the Problems panel.
- The 💡 quick fix can remove an unused declaration, convert fixed-format code, or turn a check off.
- Each check can be switched on or off under *Settings → Vanthrex: Lint Rules*.

### 13. Fixed → free format conversion

**What:** Converts fixed-format C-specs into free format, with indentation, indicator handling and `%FOUND` / `%EOF` checks.

**How:** Select the lines → right-click → **Convert Fixed-Format C-Specs to Free**. Anything it can't convert safely is marked `// TODO`.

### 14. Local history and compare

**What:** A local copy of every member and IFS file you open or save.

**How:** Right-click inside a member and pick one of:

- **Show Local History:** choose a version → **Compare** or **Restore**.
- **Compare with Copy on IBM i:** see your unsaved changes, or someone else's changes on the server.
- **Compare with Another Member:** for example DEV against PROD (`PRODLIB/QRPGLESRC(ORDENTRY)`).

In the tree, right-click a member → **Select for Compare**, then right-click another → **Compare with Selected**.

### 15. SEU-style source dates

**What:** Every line of a member shows when it was last changed, like the date column in SEU. Lines you edit show today's date (highlighted) until you save.

**Why it helps:** You can see at a glance what changed recently, and saving keeps the dates of every line you didn't touch.

**How:**

- **Ctrl+Alt+D** (or the 📅 icon in the editor title) cycles between *date*, *sequence number + date* and *hidden*.
- Hover the start of a line for its sequence number and full date.
- Right-click → **Highlight Lines Changed Since…** (7, 30 or 90 days, or any date) highlights the lines and lists them so you can jump between them.
- Settings: `vanthrex.sourceDates.format` chooses `yymmdd` (SEU) or `iso`.

### 16. F4 prompters

**What and how:**

- **Fixed-format RPG and DDS:** put the cursor on a C, D, F, H or P spec (or a DDS line) and press **F4**. A form shows each column area with its name (Factor 1, Opcode, Result field, Length…) and allowed values. **Apply** writes it back in the right columns. **Apply & next line** keeps going, like SEU. On a blank line, F4 asks which spec to create.
- **CL commands:** in a CL source, press **F4** on a command. Vanthrex reads the command's real definition from the IBM i and shows every parameter with its prompt text, default and allowed values. The command is rewritten in proper CL source layout, with `+` continuations.
- **Prompt and Run CL Command** (quick menu): type a command name, fill in the form, and it runs.

### 17. Who has my member? (locks)

**What:** When a member is open somewhere else (for example in SEU), the editor shows a banner at the top: **🔒 Locked by *name* (USER) · job … · *SHRUPD**.

**How:**

- **✉ Ask to release** sends a message that pops up on their screen (break message), or goes to their message queue.
- **🔔 Notify me when free** checks every 15 seconds and tells you when the lock is gone.
- **More options:** show their job log, or end their job (needs *JOBCTL authority, and they lose unsaved work, so you are asked to confirm).

### 18. Edit conflict protection

**What:** Before saving, Vanthrex checks whether the member changed on the IBM i after you opened it, or is locked by another job.

**How:** You get **Compare First** (opens a side-by-side diff with the IBM i copy) or **Overwrite**. Turn it off with `vanthrex.conflictCheck`.

### 19. Member list with dates

- Each member shows its **last change date** in the tree. The tooltip adds the creation date and line count.
- **Sort Members by Name / Date** (Libraries view toolbar) puts the most recently changed members first.
- Right-click a source file → **Filter Members by Last Change…** shows only members changed today, or in the last 7, 30 or 90 days, or any number of days.

### 20. CL runner and spooled files

- **Ctrl+Alt+L** runs any CL command with your library list. Recent commands are remembered.
- *My Spooled Files:* open, save or delete your spooled output.

---

### 21. Object information

**What:** One page with everything about an object: owner, created, changed, last used and how many days it was used, size, the source member it was compiled from, journaling, last save, and every other attribute.

**Why it helps:** It replaces DSPOBJD, DSPPGM and a few queries, and the buttons take you straight to the next step.

**How:**

- Click any object in *Libraries & Source → Objects*, or right-click it → **Object Information**.
- The buttons open the source, show who has the object locked, list where it is used, edit a file's data or generate its SQL.
- From the quick menu (**Ctrl+Alt+I**) → *Object information…* and type `LIBRARY/OBJECT`.

### 22. Who has this object locked?

**What:** The jobs holding a lock on any object (a file, data area, program…), with the person's name and the lock state — like WRKOBJLCK.

**How:** Right-click an object → **Who Has This Object Locked?** Click a job to see its job log, send the user a message asking them to release it, or end the job (needs *JOBCTL).

### 23. Compare two libraries

**What:** Compares two libraries, for example DEV and PROD, and lists the source members and objects that are only in one of them or different. The newer side is shown.

**Why it helps:** Before a promotion you see exactly what will change, and you can open a side-by-side diff of any changed member with one click.

**How:** Right-click a library → **Compare Two Libraries…** (or the quick menu), pick the two libraries. Click a *different* member to compare its text; click an object for its information.

### 24. Modules & exports

**What:** For a service program: its exported procedures and data in signature order. For a service program or ILE program: its bound modules with their source and dates. Modules whose source changed after they were compiled are highlighted.

**How:** Right-click a *SRVPGM or *PGM → **Show Modules & Exports**. Click a module to open its source.

### 25. SQL power tools

- **Generate SQL (DDL):** right-click a file → **Generate SQL (DDL)**, or run the command and type `LIB/OBJECT`. Works for tables, physical and logical files, views, indexes, procedures and functions. The CREATE statement opens in a new SQL editor. Needs a Mapepire SQL engine.
- **Run SQL Script:** **Ctrl+Shift+Enter** in a SQL editor runs every statement in the file (or the selection) one after another. Each statement shows ✔ or ✖, its time, its rows or row count, or its error. It stops at the first error unless you turn off `vanthrex.sql.scriptStopOnError`. It asks once before running destructive statements.
- **SQL history:** every statement you run is remembered (last 50). **SQL History…** lets you run it again, open it, insert it at the cursor or copy it. Click ☆ to save it.
- **Saved queries:** in a SQL editor, right-click → **Save Query…** and give it a name. **Saved Queries…** lists them for running or inserting; the 🗑 button deletes one.

### 26. Procedure & copybook tools (RPG)

- **Generate prototype from procedure:** put the cursor inside a free-form procedure → right-click → **Generate Prototype from Procedure**. The DCL-PR (return type and every parameter, with their keywords) is copied to the clipboard, ready to paste into your prototype copybook.
- **Extract to procedure:** select whole lines of free-form calculations → right-click → **Extract to Procedure…** and name it. The lines move into a new procedure at the end of the source and are replaced by a call. Vanthrex refuses when that would change what the code does: lines using local variables of the enclosing procedure, RETURN/LEAVE/ITER, declarations, or a block that is opened but not closed (and the other way round). Programs with procedures need `CTL-OPT DFTACTGRP(*NO)`; you are reminded if it is missing.
- **Check /COPY usage:** right-click in an RPG source → **Check /COPY Usage**. Each copybook is listed with the declarations your source uses from it, so unused copybooks stand out. In fully free sources the ☐ button comments the unused ones out.

### Coming next: IBM i debugger

Step-through debugging (breakpoints, variables, call stack) is planned for a later release. It uses the IBM i Debug Service, which has to be set up with certificates on the server, so it will come with its own setup guide.

---

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Ctrl+Alt+I | Quick menu |
| Ctrl+Alt+C | Compile |
| Ctrl+Enter | Run SQL statement |
| Ctrl+Alt+L | Run CL command |
| Ctrl+Alt+O | Search objects |
| Ctrl+Alt+F | Search source code |
| F12 / Shift+F12 / F2 | Go to definition / Find references / Rename |
| F4 | Prompt the spec (RPG / DDS) or CL command at the cursor |
| Ctrl+Alt+D | Cycle source dates display |
| Ctrl+Shift+Enter | Run the whole SQL script |

On a Mac, use **Cmd** instead of **Ctrl**.

## Tips

- **SQL engine:** keep it on *Automatic*. It uses Mapepire over SSH when Java is available, which is the fastest option and needed for *Where Used*.
- **When something fails:** open **View → Output → "Vanthrex for IBM i"** to see the exact commands and messages.
- **Where to put objects:** set *Compile objects into* in the connection form to send objects to a development library automatically.
