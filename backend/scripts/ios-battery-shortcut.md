# Phone and tablet battery in Valkyrie (iOS Shortcut)

The iPhone and iPad show up in System > Hosts as real hosts. Two things feed them:

- Online and last seen come from odin's own `tailscale status`. Nothing to set up.
- Battery comes from a Shortcuts automation on the device, which posts it to
  `POST /api/devices/<phone|tablet>/report` with that device's own token.

## What iOS can and cannot report

| Reading | Possible | How |
| --- | --- | --- |
| Battery percent | Yes | Built in: Get Battery Status, set to Battery Level (iOS 16.2 and later; earlier iOS calls it Get Battery Level) |
| Charging, on the charger | Yes | Built in: Get Battery Status, set to Is Charging or Is Connected to Charger |
| Storage used and total | Only with a paid app | Shortcuts has no storage action. Toolbox Pro's storage action can read it, and it needs Toolbox Pro Premium |
| CPU, memory, screen time, app usage | No | iOS does not give these to Shortcuts |

The endpoint takes storage when it is sent, so adding Toolbox Pro later needs no server change.

## 1. Get a token (on odin, once per device)

From `~/valkyrie/backend`, as the user the API runs as:

```bash
node --import tsx scripts/deviceToken.mts phone
node --import tsx scripts/deviceToken.mts tablet
```

Each prints a token once. Running it again replaces the old token straight away (the old Shortcut starts getting 401). Run it from a Valkyrie terminal on the phone itself and the token can be copied right into the Shortcut, with no other copy left anywhere. Do not screenshot the finished Shortcut: the token is visible in it.

`node --import tsx scripts/deviceToken.mts --status` shows which devices have a token. `... phone --revoke` turns the phone's token off.

## 2. Build the Shortcut (on the phone)

Shortcuts > My Shortcuts > + , name it **Valkyrie battery**. Add these actions in order:

1. **Get Battery Status**. Leave it on Battery Level.
2. **Get Battery Status** again. Tap Battery Level and change it to **Is Charging**.
3. **Get Battery Status** a third time. Change it to **Is Connected to Charger**.
4. **Get Contents of URL**:
   - URL: `http://odin:8420/api/devices/phone/report`
   - Method: **POST**
   - Headers: add one. Key `Authorization`, value `Bearer ` followed by the token (one space after Bearer).
   - Request Body: **JSON**. Add three fields:
     - `battery`, type **Number**, value: the output of action 1 (Battery Level)
     - `charging`, type **Boolean**, value: the output of action 2 (Is Charging)
     - `connected`, type **Boolean**, value: the output of action 3 (Is Connected to Charger)

For the iPad, build the same Shortcut on the iPad with `tablet` in place of `phone` in the URL and the tablet's token.

Optional storage, with Toolbox Pro Premium installed: add its storage action before step 4, once for used space in GB and once for total capacity in GB (numbers, no units), and add two more Number fields, `storageUsedGb` and `storageTotalGb`. Both must be sent together.

Run it once from the Shortcuts list. It shows a small result like `{"ok":true,"device":"phone","battery":87,"status":"charging"}`, and the phone appears under System > Hosts with its battery.

If `odin` does not resolve on the device, use the same address the Valkyrie web app on that device opens (odin's tailnet address, port 8420). A full MagicDNS name only works if it is listed in odin's `ALLOWED_HOSTS` or `TAILNET_ORIGINS`; otherwise the API answers 403 unknown host.

## 3. Make it run by itself (Automation tab)

Shortcuts > Automation > + . For each trigger below, pick it, choose **Run Immediately**, turn **Notify When Run** off, and pick the Valkyrie battery shortcut.

- **Charger**: Is Connected.
- **Charger**: Is Disconnected.
- **Battery Level**: Falls Below 50%. Make separate ones for Falls Below 20% and Rises Above 80%.
- **Time of Day**: every few hours, for example 8:00 AM, 12:00 PM, 4:00 PM, 8:00 PM and 12:00 AM, each repeating daily. Valkyrie marks a reading older than 3 hours as stale, so this keeps it current through the day.
- **Opening Valkyrie**: the App trigger only lists installed apps, and Valkyrie on the phone is a Home Screen web app, which it does not list as far as I can tell. If Valkyrie does appear under App on your device, add **Is Opened** with the same settings. If it does not, the time of day triggers cover it.

## Notes

- The URL is odin's tailnet name, so the device must be on Tailscale when the automation runs. When it is not, that run fails and Shortcuts may show an error banner; the next trigger catches up.
- Limits: 30 reports per device and 60 requests per address per 10 minutes, and 10 failed token checks from one address lock that address out for 10 minutes.
- Accepted values: `battery` 0 to 100 (a fraction such as 0.87 is read as 87); `charging` and `connected` as true/false (Yes/No and 1/0 also work); storage in decimal GB.
