# Overleaf Comments

See, reply to, resolve and add Overleaf review comments inside VS Code, for projects you sync with Overleaf's git bridge.

## Use

1. Open your git clone of the Overleaf project (remote `https://git.overleaf.com/<project id>`; needs an Overleaf plan with git integration).
2. Run **Overleaf Comments: Set Session Cookie** and paste your `overleaf_session2` cookie (kept in VS Code's secret storage).
3. Comments appear in the text and in the **Overleaf Comments** sidebar. Select text and click the `+` in the gutter to add one.

Nothing else to install (the Overleaf client is bundled). Comment on text you haven't pushed yet and it waits as "Not synced", then sends itself once Overleaf has the text.

Settings: `overleafComments.projectId`, `overleafComments.baseUrl`, `overleafComments.refreshMinutes`.

## Develop

```sh
git clone --recurse-submodules https://github.com/fredericosantos/overleaf-comments
cd overleaf-comments/vendor/olcli && npm ci && npm run build && cd ../..
npm install && npm test && npm run build
```

MIT. Not affiliated with Overleaf. Icon from [Lucide](https://lucide.dev) (ISC); bundled third-party code is listed in `THIRD_PARTY_NOTICES.md`.
