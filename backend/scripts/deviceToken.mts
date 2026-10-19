/**
 * Issues (or revokes) the token an iOS Shortcut uses to post a device's
 * battery to POST /api/devices/<id>/report. Run it on odin, from
 * ~/valkyrie/backend, as the user the API runs as (it writes the same
 * DATA_DIR/devices.sqlite):
 *
 *   node --import tsx scripts/deviceToken.mts phone            new token, printed once
 *   node --import tsx scripts/deviceToken.mts tablet
 *   node --import tsx scripts/deviceToken.mts phone --revoke   the phone's Shortcut gets 401
 *   node --import tsx scripts/deviceToken.mts --status         which devices have a token
 *
 * Only the token's SHA-256 is stored. A new token replaces the old one at
 * once, no restart needed. Paste it into the Shortcut's Authorization header
 * (scripts/ios-battery-shortcut.md) and do not keep another copy.
 */
import { DEVICE_IDS, hasDeviceToken, isDeviceId, issueDeviceToken, revokeDeviceToken } from '../src/lib/devices.ts'

const argv = process.argv.slice(2)
const id = argv.find((a) => !a.startsWith('--'))

if (argv.includes('--status')) {
  for (const d of DEVICE_IDS) console.log(`${d}: ${hasDeviceToken(d) ? 'token set' : 'no token'}`)
  process.exit(0)
}
if (!isDeviceId(id)) {
  console.error(`usage: deviceToken.mts <${DEVICE_IDS.join('|')}> [--revoke] | --status`)
  process.exit(2)
}
if (argv.includes('--revoke')) {
  console.log(revokeDeviceToken(id) ? `${id}: token revoked` : `${id}: had no token`)
  process.exit(0)
}
const token = issueDeviceToken(id)
console.log(`${id} token (shown once, replaces any earlier one):`)
console.log(token)
