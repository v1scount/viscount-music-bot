export const name = "nodeError";

export function execute(node, error) {
  console.error(`[lavalink] Node "${node.name}" error:`, error?.message ?? error);
}
