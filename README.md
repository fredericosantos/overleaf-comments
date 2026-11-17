# Overleaf Comments

See, reply to, resolve and add Overleaf review comments inside VS Code, for projects you sync with Overleaf's git bridge.

## Use

1. Open your git clone of the Overleaf project (remote `https://git.overleaf.com/<project id>`; needs an Overleaf plan with git integration).
2. Run **Overleaf Comments: Set Session Cookie** and paste your `overleaf_session2` cookie (kept in VS Code's secret storage).
3. Comments appear in the text and in the **Overleaf Comments** sidebar. Select text and click the `+` in the gutter to add one.
4. Suggestions (track changes) appear the same way, with Accept and Reject. Reject changes your local file; push it as usual.
5. To suggest instead of edit, press the pencil in the panel's title bar (Reviewing). Your edits stay in the file as "Not synced" suggestions and become suggestions on Overleaf once you push.

A workspace can also hold several Overleaf clones: a multi-root workspace, or one folder with a clone per paper. The comments shown are those of the project of the file you are editing; switching to a file of another clone switches the project (its name is shown in the sidebar and the status bar). **Overleaf Comments: Select Project** picks one by hand.

Nothing else to install (the Overleaf client is bundled). Comment on text you haven't pushed yet and it waits as "Not synced", then sends itself once Overleaf has the text.

Settings: `overleafComments.projectId`, `overleafComments.baseUrl`, `overleafComments.refreshMinutes`.

## Develop

```sh
git clone --recurse-submodules https://github.com/fredericosantos/overleaf-comments
cd overleaf-comments/vendor/olcli && npm ci && npm run build && cd ../..
npm install && npm test && npm run build
```

MIT. Not affiliated with Overleaf. Icon from [Lucide](https://lucide.dev) (ISC); bundled third-party code is listed in `THIRD_PARTY_NOTICES.md`.
