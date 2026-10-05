# Ask the IBM i AI assistant

Type **@vanthrex** in the VS Code chat (needs GitHub Copilot Chat or another chat model):

- `/explain` — what does this RPG / CL do?
- `/document` — header and procedure comments
- `/review` — bugs, performance and security issues
- `/modernize` — fixed format to modern **FREE RPG
- `/test` — RPGUnit tests for a procedure
- `/fix` — explain and fix the compile errors (also from the 💡 on a compile error)
- `/sql` — write Db2 for i SQL from a description, using your real tables and columns
- `/object MYLIB/ORDENTRY *PGM` — what is this object and who uses it?

The assistant can look things up on the connected system (object descriptions, table columns, source, read-only queries).
It never changes data, and it asks before running a query. In Copilot agent mode you can use the same tools as
`#ibmiQuery`, `#ibmiSource`, `#ibmiObject`, `#ibmiSearch` and `#ibmiStatus`.
