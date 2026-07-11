const DEBUG = ["1", "true", "yes", "on"].includes(
  String(process.env.DEBUG ?? "").toLowerCase(),
);

/**
 * @param {string} scope
 * @param  {...unknown} args
 */
export function log(scope, ...args) {
  console.log(`[${scope}]`, ...args);
}

/**
 * @param {string} scope
 * @param  {...unknown} args
 */
export function debug(scope, ...args) {
  if (!DEBUG) return;
  console.debug(`[debug:${scope}]`, ...args);
}

/**
 * @param {string} scope
 * @param {unknown} error
 * @param {Record<string, unknown>} [context]
 */
export function logError(scope, error, context = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[${scope}] ${message}`);
  if (Object.keys(context).length > 0) {
    console.error(`[${scope}] context:`, context);
  }
  if (stack) {
    console.error(stack);
  }

  return message;
}

export function isDebugEnabled() {
  return DEBUG;
}

/**
 * Safe ephemeral error text for Discord replies.
 * @param {unknown} error
 */
export function formatUserError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (isDebugEnabled()) {
    return `Something went wrong:\n\`\`\`\n${message.slice(0, 1500)}\n\`\`\``;
  }
  return "Something went wrong while running that command. Check the bot logs for details.";
}
