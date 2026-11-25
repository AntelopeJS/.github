/** What one process run returned. */
export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Runs one process to completion. Every process the train starts goes through it. */
export type Run = (command: string, args: readonly string[], options?: { cwd?: string }) => RunResult;

/** Everything the train touches outside its own memory. */
export interface System {
  run: Run;
  sleep: (milliseconds: number) => void;
  out: (text: string) => void;
  err: (text: string) => void;
  cacheDirectory: string;
}

/** Runs a process and returns its standard output, or throws with its standard error when it fails. */
export function exec(system: System, command: string, args: readonly string[]): string {
  const result = system.run(command, args);
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr.trim()}`);
  }
  return result.stdout;
}
