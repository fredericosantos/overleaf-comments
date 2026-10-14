/** Overleaf's git bridge remote looks like https://git.overleaf.com/<24-hex project id>. */
export function projectIdFromRemote(line: string): string | undefined {
  return /git\.[^/\s]*overleaf[^/\s]*\/([0-9a-f]{24})(?![0-9a-f])/i.exec(line)?.[1];
}
