import type { CameraPose } from '../engine'

export { thorTower, TOWER_FX } from './tower'
export { odinServer, SERVER_FX } from './server'
export { room, bulbSpots } from './room'
export { Builder, AX, rrLoop } from './build'
export { frameHeadset, FRAME_FX } from './frame'
export { laptop, LAPTOP_FX } from './laptop'
export { phone, tablet, PHONE_FX, TABLET_FX } from './slate'

/**
 * Camera poses, degrees. All models are built to a ~4 unit radius, so the
 * same poses work for each. yaw 0 = straight at the front, +yaw swings toward
 * the glass side (+x), 180 = rear.
 */
export const POSES: Record<string, CameraPose> = {
  /** front 3/4, slightly above (f018) */
  home: { yaw: 38, pitch: 11, dist: 14.5, fov: 38 },
  /** rear 3/4, low and close (System > Hosts) */
  hosts: { yaw: 142, pitch: 14, dist: 14, fov: 38 },
  /** same as hosts; kept so older screens keep working, use 'hosts' */
  track: { yaw: 142, pitch: 14, dist: 14, fov: 38 },
  /** opposite side, higher, wider (Lights / room) */
  lights: { yaw: -40, pitch: 28, dist: 15, fov: 38 },
  /** glass side, nearly level, cinematic (Media) */
  media: { yaw: 82, pitch: 4, dist: 13.5, fov: 38 },
  /** same as media, older name */
  listen: { yaw: 82, pitch: 4, dist: 13.5, fov: 38 },
  /** front, high, looking down into the case */
  claude: { yaw: 14, pitch: 34, dist: 15, fov: 38 },
  /** top-rear (f016), Home > Settings */
  settings: { yaw: 206, pitch: 36, dist: 15, fov: 38 },
  /** same as settings, older name */
  display: { yaw: 206, pitch: 36, dist: 15, fov: 38 },
  /** raised front 3/4 for the device models (headset strap loop, laptop keyboard, slab camera bump) */
  device: { yaw: 32, pitch: 26, dist: 14.5, fov: 38 },
}

/** The pose names screens should use (POSES also keeps the older aliases track, listen, display). */
export const POSE_NAMES = ['home', 'hosts', 'lights', 'media', 'claude', 'settings'] as const
