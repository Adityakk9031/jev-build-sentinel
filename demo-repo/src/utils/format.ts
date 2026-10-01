export function formatSubject(s: string): string {
  return s.trim();
}

export function formatBody(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
