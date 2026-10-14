# Overleaf Comments

VS Code extension that shows Overleaf review comments (threads, replies, resolved state) next to your
text, for projects you sync with Overleaf's git bridge. Git carries your files; comments live only in
Overleaf's UI, so this fetches them live and renders them with VS Code's native comments UI.

Read-only. Comments are cached in VS Code workspace storage (outside the repo), never committed.

## Use

1. Open the git clone of your Overleaf project (remote `https://git.overleaf.com/<project id>`).
2. Run **Overleaf Comments: Set Session Cookie** and paste your `overleaf_session2` cookie
   (browser devtools → Storage → Cookies → overleaf.com). It is kept in VS Code SecretStorage.
3. Comments appear in the gutter and the Comments panel. **Overleaf Comments: Refresh** re-fetches.

Settings: `overleafComments.projectId` (override git-remote detection), `overleafComments.baseUrl`
(self-hosted), `overleafComments.showResolved`.

Anchors are matched by the commented text, nearest to Overleaf's offset; if you edited that text
locally the thread is labelled "anchor lost" at its approximate position.

## Develop

```sh
git clone --recurse-submodules https://github.com/fredericosantos/overleaf-comments
cd overleaf-comments/vendor/olcli && npm ci && npm run build && cd ../..
npm install && npm test && npm run build
code --extensionDevelopmentPath=$PWD <your-overleaf-clone>
```

Built on a fork of [olcli](https://github.com/aloth/olcli) (`vendor/olcli`) whose comment listing is
about 2.5x faster (parallel sockets); the upstream PR is tracked in issue #1.
