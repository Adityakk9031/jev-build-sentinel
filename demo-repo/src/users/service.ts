export interface User {
  id: string;
  email: string;
  active: boolean;
}

export function deactivate(user: User): User {
  return { ...user, active: false };
}

export function findByEmail(users: User[], email: string): User | undefined {
  return users.find((u) => u.email === email);
}
