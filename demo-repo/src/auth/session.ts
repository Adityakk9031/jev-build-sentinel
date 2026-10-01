export function createSession(userId: string): { token: string; userId: string } {
  return { token: `tok_${userId}`, userId };
}

export function validateSession(token: string): boolean {
  return token.startsWith('tok_');
}

export function destroySession(token: string): void {
  void token;
}
