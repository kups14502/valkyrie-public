# "Hey Siri, Raven" (iOS Shortcut)

Raven is the assistant in Valkyrie's Raven tab. This Shortcut lets you talk to it from the phone without opening
the app: Siri takes your words, the Shortcut posts them to Raven, waits for the answer and reads it out. The message
and the answer also land in the Raven tab, so you can read them there later.

The endpoint is `POST /api/raven/say`. It waits up to 55 seconds for Raven's answer. When a job takes longer, the
Shortcut says "Still working on it. I will message you when it is done." and the answer arrives in the Raven tab as a
notification.

## What you need

- The phone on Tailscale. The URL below uses odin's tailnet name; off the tailnet the Shortcut fails.
- odin's tailnet name: the https address the Valkyrie web app opens on the phone (`odin.<tailnet>.ts.net`, the
  `tailscale serve` name in odin's `TAILNET_ORIGINS`). It is written as `<odin>` below; this repo is published, so the
  name itself stays out of it.
- The phone is a trusted tailnet device (it is listed in odin's `TRUSTED_TAILNET_IPS`), so the Shortcut needs no token.
  On any other device, add a header `Authorization` with the value `Bearer ` and a Valkyrie app token.
- That name must be one of odin's `TAILNET_ORIGINS` or `ALLOWED_HOSTS`. If the Shortcut gets 403 unknown host, add
  it there and restart the API.

## 1. Build the Shortcut

Shortcuts > My Shortcuts > + . Name it **Raven** (the name is what you say to Siri). Add these actions in order:

1. **Dictate Text**. Tap the arrow and set Stop Listening to **After Pause**. Language: English (US).
2. **Get Contents of URL**:
   - URL: `https://<odin>/api/raven/say`
   - Method: **POST**
   - Headers: add one. Key `Content-Type`, value `application/json`.
   - Request Body: **JSON**. Add three fields:
     - `text`, type **Text**, value: the **Dictated Text** variable (the output of action 1)
     - `wait`, type **Boolean**, value: **True**
     - `source`, type **Text**, value: `siri`
3. **Get Dictionary Value**: Get **Value** for key `reply` in **Contents of URL**.
4. **Speak Text**: speak the **Dictionary Value**. Leave Wait Until Finished on.

Run it once from the Shortcuts list and say something short ("what is on my calendar today"). The first run asks
permission to connect to odin's name: tap **Always Allow**.

The answer comes back as plain text for speech: no links, no lists. Raven also knows the message came by voice and
keeps the answer to one or two sentences.

## 2. Start it with one press or by voice

- **Siri**: "Hey Siri, Raven". Siri runs the Shortcut by its name.
- **Action Button** (iPhone 15 Pro and later): Settings > Action Button > swipe to **Shortcut** > Choose a Shortcut >
  **Raven**.
- **Back Tap** (any recent iPhone): Settings > Accessibility > Touch > Back Tap > **Double Tap** > **Raven**. Two taps
  on the back of the phone start it.
- **Lock Screen or Control Center**: add the Shortcuts control and pick **Raven**.

## 3. Variations

- **Type instead of talk**: replace action 1 with **Ask for Input** (Text). Everything else stays.
- **Fire and forget**: set `wait` to **False** and drop actions 3 and 4. The Shortcut returns at once with
  `{"ok":true,"id":123}`, and the answer arrives in the Raven tab as a notification.
- **Office hotkey**: the desktop app opens Raven's quick sheet on Ctrl+Shift+Space. A script can also post straight to
  the same endpoint with `"source": "hotkey"`.

## What the endpoint answers

```json
{ "ok": true, "id": 412, "reply": "You have the dentist at 2:30 PM ET and nothing after.", "done": true }
```

- `done: false` means Raven is still working; the `reply` is the "still working" line.
- A failed run answers `done: true` with a reply that starts "That failed:".
- 401 means the phone is not a trusted tailnet device and no token was sent. 404 means the request came through
  Cloudflare instead of the tailnet (Raven is tailnet only).
