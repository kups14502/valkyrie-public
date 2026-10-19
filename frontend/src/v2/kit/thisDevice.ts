import type { DeviceMode } from '../../lib/deviceMode'
import type { HostModelId } from './hero'

// Which device the page is running on, as the host id System > Hosts and the
// x-ray models use (kit/hero). The desktop app knows its machine by name (the
// local_hostname command in src-tauri/src/lib.rs); everywhere else the device
// profile decides (lib/deviceMode). Kept free of React and the API so the
// unit test (e2e/device-unit.mjs) runs it in plain node.

/** Machines the desktop app runs on, by the name it reports (COMPUTERNAME or HOSTNAME, lowercased). */
const APP_HOSTS: readonly HostModelId[] = ['thor', 'mimir', 'odin']

const BY_MODE: Record<DeviceMode, HostModelId> = { iphone: 'phone', ipad: 'tablet', vr: 'frame', desktop: 'thor', auto: 'thor' }

/**
 * The host id of the device in front of Brendon. `hostname` is what the
 * desktop app's local_hostname answered (null in a browser): a known machine
 * wins, matched on its first label ("THOR", "thor.local"). Anything else goes
 * by the resolved device profile: the iPhone is the phone, the iPad the
 * tablet, the headset the Steam Frame (host 'frame', labeled Loki), and a
 * desktop browser (or a machine the app does not know) thor.
 */
export function thisDeviceId(hostname: string | null | undefined, mode: DeviceMode): HostModelId {
  const name = (hostname ?? '').trim().toLowerCase().split('.')[0]
  const app = APP_HOSTS.find((h) => h === name)
  return app ?? BY_MODE[mode] ?? 'thor'
}
