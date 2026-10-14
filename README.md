# Overleaf Comments

VS Code extension that shows Overleaf review comments (threads, replies, resolved state) next to your
text, for projects you sync with Overleaf's git bridge. Git carries your files; comments live only in
Overleaf's UI, so this fetches them live and renders them with VS Code's native comments UI.

Comments are cached in VS Code workspace storage (outside the repo), never committed.

## What you can do

- **Read:** threads show in the gutter, the Comments panel, and an **Overleaf Comments** view in the activity bar (files, threads, replies; click to jump). Drag that view to the secondary side bar to keep it on the right, as in Overleaf.
- **Markers:** the commented text is faintly highlighted (orange open, green resolved) and hovering it shows the thread. The comment icon is VS Code's native one: on the last line of a multi-line comment, where the thread opens.
- **One place for comments:** the extension has its own **Overleaf Comments** view in the activity bar (drag it to the secondary side bar if you want it on the right) and stops VS Code's built-in bottom Comments panel from opening by itself (`comments.openView` is set to `never` while the extension is installed). You can still open that panel by hand.
- **Hover:** hovering the highlighted text shows the thread (long threads are clipped: first 2 and latest 3 messages, 400 characters each) with **Reply** and **Resolve**/**Reopen** links. Threads open only from VS Code's comment icon or the side panel, never by clicking the text.
- **Buttons:** each thread has Reply (the reply box), Resolve/Reopen and Close (collapse) in its header.
- **Reply:** type in the thread's reply box, or use the reply button in the sidebar.
- **Resolve / reopen:** the check button on a thread. It looks resolved immediately and reverts with an error if Overleaf refuses. Resolved threads stay visible (and in the Comments panel), greyed, and can be reopened.
- **New comment:** select text, click the `+` in the gutter, type. With nothing selected it anchors to the clicked line's text, and a blank line is anchored to its line break. the extension asks Overleaf to anchor to that exact occurrence and warns if Overleaf attached it to different text (for example when your local file differs from Overleaf's copy; `git pull` first).

Comment widgets always open below their line; VS Code has no setting for placing them above.

## Use

1. Open the git clone of your Overleaf project (remote `https://git.overleaf.com/<project id>`).
2. Run **Overleaf Comments: Set Session Cookie** and paste your `overleaf_session2` cookie
   (browser devtools → Storage → Cookies → overleaf.com). It is kept in VS Code SecretStorage.
3. Comments appear in the gutter and the Comments panel. **Overleaf Comments: Refresh** re-fetches.

Settings: `overleafComments.projectId` (override git-remote detection), `overleafComments.baseUrl`
(self-hosted), `overleafComments.refreshMinutes` (re-fetch on window focus when older than N minutes; default 5, 0 = off).

For scripted or throwaway launches you can instead start VS Code with `OVERLEAF_SESSION_COOKIE` set in its environment; the stored cookie takes precedence.

If you see "No session cookie", this VS Code profile has no cookie yet: run **Overleaf Comments: Set Session Cookie** once (the cookie is stored per VS Code profile).

Anchors are matched by the commented text, nearest to Overleaf's offset; if you edited that text
locally the thread is labelled "anchor lost" at its approximate position.

Install a built package with `code --install-extension overleaf-comments.vsix`
(`npx @vscode/vsce package --no-dependencies -o overleaf-comments.vsix` after building).
**Overleaf Comments: Clear Session Cookie** removes the stored cookie and cached comments.

## Develop

```sh
git clone --recurse-submodules https://github.com/fredericosantos/overleaf-comments
cd overleaf-comments/vendor/olcli && npm ci && npm run build && cd ../..
npm install && npm test && npm run build
npm run dev          # throwaway VS Code on a scratch Overleaf project (needs olcli logged in)
npm run test:host   # drives an isolated VS Code (set VSCODE_EXECUTABLE if not in /Applications)
code --extensionDevelopmentPath=$PWD <your-overleaf-clone>
```

Built on a fork of [olcli](https://github.com/aloth/olcli) (`vendor/olcli`) whose comment listing is
about 2.5x faster (parallel sockets); the upstream PR is tracked in issue #1.
