/**
 * Quoting a value for a shell the platform does not control.
 *
 * Everything a task runs in a worker goes through `bash -l` with interpolated values — a branch
 * name, a file path, a model id — and every one of them comes from a user. Single-quoting the
 * POSIX way (close, escape, reopen) is the only form that needs no allow-list: inside single
 * quotes a shell interprets nothing at all, and the one character that ends them is handled.
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
