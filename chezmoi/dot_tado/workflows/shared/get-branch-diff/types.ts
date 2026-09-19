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
