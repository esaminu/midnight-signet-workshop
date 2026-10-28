export class TodoError extends Error {}

export function todo(part: number, what: string): never {
  throw new TodoError(
    `TODO(part ${part}) is not done yet: ${what}. Write it in src/flows/, or run \`yarn finish ${part}\`.`,
  );
}

export const isTodo = (fn: (...args: never[]) => unknown): boolean => /\btodo\(/.test(fn.toString());
