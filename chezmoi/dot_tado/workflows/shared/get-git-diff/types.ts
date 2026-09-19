export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface FileChange {
  path: string;
  status: string;
  oldPath: string | null;
}

export interface Stat {
  files: number;
  insertions: number | null;
  deletions: number | null;
}

export interface Section {
  files: FileChange[];
  stat: Stat;
  diff: string | null;
}
