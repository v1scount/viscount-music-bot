export const FILTER_NAMES = {
  off: "Off",
  bassboost: "Bass boost",
  nightcore: "Nightcore",
  karaoke: "Karaoke",
};

export async function applyFilter(player, name) {
  if (!Object.hasOwn(FILTER_NAMES, name)) {
    throw new Error(`Unknown filter: ${name}`);
  }

  player.filters = new Filters(player);
  await player.filters.updateFilters();

  if (name === "bassboost") {
    await player.filters.setEqualizer([
      { band: 0, gain: 0.25 },
      { band: 1, gain: 0.2 },
      { band: 2, gain: 0.15 },
      { band: 3, gain: 0.1 },
      { band: 4, gain: 0.05 },
    ]);
  } else if (name === "nightcore") {
    await player.filters.setTimescale({ speed: 1.2, pitch: 1.2, rate: 1 });
  } else if (name === "karaoke") {
    await player.filters.setKaraoke({
      level: 1,
      monoLevel: 1,
      filterBand: 220,
      filterWidth: 100,
    });
  }

  return name;
}
import { Filters } from "poru";
