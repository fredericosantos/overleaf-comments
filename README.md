# Overleaf Comments

VS Code extension that shows Overleaf review comments (threads, replies, resolved state) next to your
text, for projects you sync with Overleaf's git bridge. Git carries your files; comments live only in
Overleaf's UI, so this fetches them live and renders them with VS Code's native comments UI.

Comments are cached in VS Code workspace storage (outside the repo), never committed.

## What you can do

- **Read:** open comments are drawn in the text as a faint highlight (exactly the commented text, or whole lines when the comment spans several lines) with VS Code's native comment icon, which sits on the last line of a multi-line comment, where the thread opens. Hovering the highlight shows the thread: authors in their own colors, long threads clipped (first 2 and latest 3 messages, 400 characters each), with **Reply** and **Resolve** links.
- **Sidebar:** the **Overleaf Comments** view in the activity bar lists every comment, open and resolved, by file (drag the view to the secondary side bar to keep it on the right). Click one to jump to it; open ones have Reply and Resolve buttons, resolved ones a Reopen button. Resolved comments are shown only here, never in the text. The extension sets `comments.openView` to `never` so VS Code's own bottom Comments panel does not also open by itself (you can still open or hide it by hand).
- **Reply:** type in a thread's reply box. The box clears at once and your text shows as "Syncing…" until Overleaf has it; if the send fails the text is removed again and you get **Retry** and **Copy text**.
- **Resolve / reopen:** the check button on a thread, **Resolve** in the hover, or the sidebar. The comment moves between the text and the sidebar's resolved list immediately, and stays there even if Overleaf is slow to report it; if Overleaf refuses it moves back and the error is shown.
- **New comment:** select text, click the `+` in the gutter, type. With nothing selected it anchors to the clicked line's text; a blank line is anchored to its line break. The extension asks Overleaf to anchor to that exact occurrence (also on CRLF files) and warns if Overleaf attached it to different text. If the text is not in Overleaf's copy yet, it offers to commit that one file and push the current branch, then adds the comment (it refuses a detached HEAD or a branch without an upstream).
- **Close:** each open thread's header has a Close button (collapse), and clicking anywhere else in the text closes open comments (clicking inside a comment's own text leaves it open). Threads open only from the comment icon or the sidebar, never by clicking the text.

Comment widgets always open below their line; VS Code has no setting for placing them above, and no extension API to focus a thread's reply box (the hover's Reply is best effort).

## Use

1. Open the git clone of your Overleaf project (remote `https://git.overleaf.com/<project id>`).
2. Run **Overleaf Comments: Set Session Cookie** and paste your `overleaf_session2` cookie
   (browser devtools → Storage → Cookies → overleaf.com). It is kept in VS Code SecretStorage.
3. Comments appear in the text and in the **Overleaf Comments** sidebar. **Overleaf Comments: Refresh** re-fetches. The extension stays quiet in git repositories that are not Overleaf projects.

Settings: `overleafComments.projectId` (override git-remote detection), `overleafComments.baseUrl`
(self-hosted), `overleafComments.refreshMinutes` (re-fetch on window focus when older than N minutes; default 5, 0 = off).

For scripted or throwaway launches you can instead start VS Code with `OVERLEAF_SESSION_COOKIE` set in its environment; the stored cookie takes precedence.

If you see "No session cookie", this VS Code profile has no cookie yet: run **Overleaf Comments: Set Session Cookie** once (the cookie is stored per VS Code profile).

Anchors are matched by the commented text, nearest to Overleaf's offset, and followed through your edits; if you edit inside the commented text and it can no longer be found, the thread is labelled "Anchor lost" at its last position.

Install a built package with `code --install-extension overleaf-comments.vsix`
(`npx @vscode/vsce package --no-dependencies -o overleaf-comments.vsix` after building).
**Overleaf Comments: Clear Session Cookie** removes the stored cookie and cached comments.

## Develop

```sh
git clone --recurse-submodules https://github.com/fredericosantos/overleaf-comments
cd overleaf-comments/vendor/olcli && npm ci && npm run build && cd ../..
npm install && npm test && npm run build   # npm test is plain node (pure logic + a real-git test): opens nothing
npm run dev          # OPENS a throwaway VS Code window on a scratch Overleaf project (needs olcli logged in)
npm run test:host   # OPENS an isolated VS Code window for ~15 s (set VSCODE_EXECUTABLE if not in /Applications)
code --extensionDevelopmentPath=$PWD <your-overleaf-clone>
```

Built on a fork of [olcli](https://github.com/aloth/olcli) (`vendor/olcli`) whose comment listing is
about 2.5x faster (parallel sockets); the upstream PR is tracked in issue #1.
