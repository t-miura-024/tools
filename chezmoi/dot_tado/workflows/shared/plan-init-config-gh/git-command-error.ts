export class GitCommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(params: {
    command: string;
    args: readonly string[];
    exitCode: number | null;
    stderr: string;
    cause?: unknown;
  }) {
    super(
      `${params.command} ${params.args.join(" ")} exited with code ${params.exitCode}: ${params.stderr.trim()}`,
    );
    this.name = "GitCommandError";
    this.command = params.command;
    this.args = params.args;
    this.exitCode = params.exitCode;
    this.stderr = params.stderr;
    if (params.cause !== undefined) {
      this.cause = params.cause;
    }
  }
}
