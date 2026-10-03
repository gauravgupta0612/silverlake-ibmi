# Add your IBM i

1. Click **Add IBM i Connection**.
2. Enter the host, your user profile and (optionally) your library list.
3. Click **Test connection**: Silverlake checks SSH and tells you which SQL engine will be used.
4. Click **Save connection**, then **Connect now**.

> SSH must be running on the IBM i: `STRTCPSVR SERVER(*SSHD)`.
> Your password is stored in the VS Code secret store, never in settings files.
