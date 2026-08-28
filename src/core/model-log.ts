/** Model-switch diagnostics — only when Telegram verbose is on for the thread. */
export function logModel(verbose: boolean, msg: string): void {
  if (verbose) console.log(msg);
}
