/** Which agent a connection belongs to, from the client_name it registered
 * with (any text up to 100 characters, its own choice): only these words ever
 * reach a log or the census, never the name itself. */
export const AGENT_FAMILIES = ['claude', 'chatgpt', 'codex', 'other'] as const;
export type AgentFamily = (typeof AGENT_FAMILIES)[number];

export function agentFamily(clientName: unknown): AgentFamily {
  const name = typeof clientName === 'string' ? clientName : '';
  if (/claude/i.test(name)) return 'claude';
  if (/codex/i.test(name)) return 'codex';
  if (/chatgpt|openai/i.test(name)) return 'chatgpt';
  return 'other';
}
