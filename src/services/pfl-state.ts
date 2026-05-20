/** Per-production set of elementIds that currently have PFL active. */
export const activePflByProduction = new Map<string, Set<string>>();

/** Per-production set of elementIds that currently have AFL active. */
export const activeAflByProduction = new Map<string, Set<string>>();

/** Per-production audio channel count — set at first controller connect. */
export const numAudioChannelsByProduction = new Map<string, number>();

/** Returns true if any PFL or AFL solo is active for the production. */
export function anySoloActive(productionId: string): boolean {
  return (activePflByProduction.get(productionId)?.size ?? 0) > 0
    || (activeAflByProduction.get(productionId)?.size ?? 0) > 0;
}

/** Clear PFL/AFL tracking state for a production on deactivation. */
export function clearProductionPflState(productionId: string): void {
  activePflByProduction.delete(productionId);
  activeAflByProduction.delete(productionId);
  numAudioChannelsByProduction.delete(productionId);
}
