export function notify(user: string, message: string): string {
  return `[to:${user}] ${message}`;
}

export function notifyAll(users: string[], message: string): string[] {
  return users.map((u) => notify(u, message));
}
