# Your IBM i source in Git

1. Right-click a library (or a source file) → **Git: Export Source to a Git Repository…** and choose a folder.
   Members are saved as `library/sourcefile/member.type`, and Vanthrex offers to create the repository and the first commit.
2. **Git: Get Changes from IBM i** brings in members changed on the system since the last sync.
3. Edit locally, then **Git: Upload Changed Files to IBM i** — to the same libraries or to your development library.
4. **Git: Commit & Push** commits with your name (or the one in `vanthrex.git.authorName`) and pushes, or publishes to GitHub.
5. **Git: History of This Member** shows every committed version of the member you are editing, with compare and restore.
