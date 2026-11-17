import { isAbsolute, relative, sep } from 'node:path';

/** Overleaf's git bridge remote looks like https://git.overleaf.com/<24-hex project id>. */
export function projectIdFromRemote(line: string): string | undefined {
  return /git\.[^/\s]*overleaf[^/\s]*\/([0-9a-f]{24})(?![0-9a-f])/i.exec(line)?.[1];
}

/** `file`'s path inside the folder `root`, with '/' separators as Overleaf names it, or undefined when it is outside. */
export function pathIn(root: string, file: string, path = { isAbsolute, relative, sep }): string | undefined {
  const rel = path.relative(root, file);
  return rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : undefined;
}
