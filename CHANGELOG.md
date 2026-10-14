# Changelog

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
