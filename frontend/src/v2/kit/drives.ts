import type { Model } from './three'

// Disks on the x-ray models. thor's tower has a hotspot and a glow group per
// M.2 slot, named for the drive in it (disk.C, disk.E, disk.F, models/tower.ts);
// the other models have a single 'disk'.

/** The hotspot and glow group of the disk named `name` in /api/hosts: "C:" is disk.C. */
export const diskKey = (name: string): string => `disk.${name.replace(/:$/, '')}`

/** The model has a hotspot for each of its drives (disk.C and so on), not one 'disk'. */
export const hasDriveSpots = (model: Model): boolean => model.hotspots.some((h) => h.id.startsWith('disk.'))

/**
 * The hotspot a disk reading ties to: the drive's own (disk.C) where the model
 * has it, else the model's one 'disk'. A reading with no drive name, or a drive
 * the model has no slot for, falls back to the model's first drive (the system
 * drive) unless `exact`. null when the model has no disk at all.
 */
export function diskSpot(model: Model, name: string | null, exact = false): string | null {
  const ids = model.hotspots.map((h) => h.id)
  const own = name ? diskKey(name) : null
  if (own && ids.includes(own)) return own
  if (ids.includes('disk')) return 'disk'
  return exact ? null : ids.find((s) => s.startsWith('disk.')) ?? null
}
