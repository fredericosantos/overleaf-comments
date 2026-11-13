# Changelog

## Unreleased

- Suggestions (track changes) appear as threads with Accept / Reject, and in the sidebar: insertions in green, deletions as a red marker, a deletion next to an insertion as "Changed: old to new". Accept only clears the marker on Overleaf (your file already has the text). Reject undoes the change in your local file, for you to push, and clears the marker on Overleaf.
- Reviewing mode (the pencil button in the Overleaf Comments panel): what you type becomes local suggestions, kept in the file and marked "Not synced". Once you push, each one is turned into a real suggestion on Overleaf (the pushed text is undone and redone as tracked; the text stays the same, so the next pull is clean).
- One pipeline for comments and suggestions: whatever waits for a push (not-synced comments, local suggestions) is kept across reloads and sent after every refresh; a push (a change of the remote-tracking refs) triggers a refresh.
- Comments and suggestions whose text is not in your local file are no longer drawn at a guessed place: they are listed in the sidebar as "not in your file (git pull?)".
- "Not synced" comments and suggestions use VS Code's "unresolved" comment icon.

## 0.1.0 (preview)

First release.

- Open Overleaf review comments appear as native VS Code comment threads, with a faint highlight on the commented text (whole lines when the comment spans several).
- A sidebar view lists every comment, open and resolved, by file; resolved comments are shown only there.
- Reply, resolve and reopen, and add new comments on a selection, a line or a blank line. Every write is optimistic ("Syncing…") with rollback and Retry / Copy text on failure.
- Text that is not on Overleaf yet is kept as a quiet "Not synced" comment (dashed outline, Retry sync / Discard) and added automatically once it is.
- Comments follow your edits and `git pull`; CRLF files are supported.
- Long comments and tall threads are collapsed with Show more / Show entire comments.
- Cookie kept in VS Code SecretStorage; comments cached per project in workspace storage.
- Known limits: VS Code cannot place a comment above its line or focus a thread's reply box from an extension; unsynced comments are not kept across a reload.
