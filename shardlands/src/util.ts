/** Channel label without an engine (for logs). */
export function channelLabelStatic(ch: string, teams: { id: string; name: string }[]): string {
  if (ch === "public") return "public";
  if (ch.startsWith("team:")) return "team";
  const [a, b] = ch.slice(8).split("|");
  const n = (id: string) => teams.find((t) => t.id === id)?.name ?? id;
  return `embassy ${n(a)}-${n(b)}`;
}
