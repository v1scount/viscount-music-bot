export const name = "nodeDisconnect";

export function execute(node, event) {
  console.warn(
    `[lavalink] Node "${node.name}" disconnected:`,
    event?.code,
    event?.reason || "(no reason)",
  );
}
