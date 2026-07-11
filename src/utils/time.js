export function parseDuration(value) {
  const input = String(value).trim();
  if (!input) return null;

  if (/^\d+$/.test(input)) {
    return Number(input) * 1000;
  }

  const parts = input.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (parts.some((part) => !/^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  const seconds = numbers.pop();
  const minutes = numbers.pop() ?? 0;
  const hours = numbers.pop() ?? 0;

  if (seconds > 59 || (parts.length === 3 && minutes > 59)) return null;
  return (hours * 3600 + minutes * 60 + seconds) * 1000;
}

export function progressBar(position, duration, size = 16) {
  if (!Number.isFinite(duration) || duration <= 0) {
    return "▬".repeat(size);
  }

  const ratio = Math.min(1, Math.max(0, position / duration));
  const marker = Math.min(size - 1, Math.floor(ratio * size));
  return `${"▬".repeat(marker)}🔘${"▬".repeat(size - marker - 1)}`;
}
