export const name = "nodeConnect";

export function execute(node) {
  const host = node.options?.host ?? node.host;
  const port = node.options?.port ?? node.port;
  console.log(`[lavalink] Connected to node "${node.name}" (${host}:${port})`);
}
