---
title: Archon on Your Phone
description: Install the Archon mobile app on an iPhone or Android Home Screen and turn on push notifications.
category: guides
area: web
audience: [user, operator]
status: current
sidebar:
  order: 13
---

Archon's web server includes a phone app at `/m`: chats, projects, runs, approvals, and deploys, sized for a touch screen. It is a web app you add to your Home Screen (a PWA, progressive web app). There is no app store listing and nothing to build.

The desktop console at `/console` is unchanged. On a narrow touch screen it shows a one-time **Open mobile view** banner; it never redirects on its own.

## What you need

- **Archon reachable from the phone over HTTPS.** Browsers install web apps and deliver push only on a secure origin. A Tailscale HTTPS address (`https://<machine>.<tailnet>.ts.net`), a Cloudflare Tunnel, or a reverse proxy with a certificate all work. Plain `http://` on a LAN address does not.
- **iPhone:** iOS 16.4 or later, and Safari for the install step.
- **Android:** Chrome, or another browser that supports installing web apps.

## Install to the Home Screen

### iPhone

1. Open `https://<your-archon-address>/m` in **Safari**.
2. Tap **Share** in the toolbar.
3. Choose **Add to Home Screen**, then **Add**.
4. Open Archon from the new icon. From now on use the icon, not the Safari tab: iOS delivers notifications only to an app opened from the Home Screen.

### Android

1. Open `https://<your-archon-address>/m` in Chrome.
2. Tap **Install app** when Chrome offers it, or open the **⋮** menu and choose **Install app** (on some versions, **Add to Home screen**).
3. Open Archon from the new icon.

The app opens to the last chat you had open. The chat list button at the top left lists every chat, grouped by project, with the ones that need you first.

## Turn on push notifications

Push needs a one-time setup on the server, and then one tap on each phone.

### 1. Give the server a VAPID key pair

Web Push identifies the sender with a VAPID key pair (Voluntary Application Server Identification). Archon reads the pair from three environment variables and never creates one itself:

| Variable | Value |
|----------|-------|
| `ARCHON_VAPID_PUBLIC` | The public key: an uncompressed P-256 point, base64url (65 bytes). |
| `ARCHON_VAPID_PRIVATE` | The matching private key, base64url (32 bytes). |
| `ARCHON_VAPID_SUBJECT` | A contact the push services can reach about this server: `mailto:you@example.com` or an `https://` URL. |

Generate a pair once, with Bun (which Archon already needs):

```bash
bun -e 'const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"]);
const pub = Buffer.from(await crypto.subtle.exportKey("raw", k.publicKey)).toString("base64url");
const { d } = await crypto.subtle.exportKey("jwk", k.privateKey);
console.log(`ARCHON_VAPID_PUBLIC=${pub}\nARCHON_VAPID_PRIVATE=${d}`);'
```

`npx web-push generate-vapid-keys` prints a pair in the same format, if you prefer it.

Add the two lines it prints to the server's `.env`, add `ARCHON_VAPID_SUBJECT`, and restart the server.

:::caution
Keep the private key secret, and keep the pair once you have made it. Every phone subscribes with the public key, so a new pair silently stops every existing subscription until each phone turns push on again.
:::

Until all three variables are set, push is off. The app's Settings screen then names the variables that are missing, or says which one is malformed.

### 2. Turn it on from the phone

1. In the app, open **Settings** (the gear in the chat list).
2. Under **Notifications**, tap **Turn on** and allow notifications when the phone asks. The prompt only appears after a tap, which iOS requires.
3. Tap **Send a test**. It should arrive within a few seconds, including on a locked phone.

On an iPhone that opened Archon in a Safari tab, Settings shows the Add to Home Screen steps instead of **Turn on**. Install first, then come back.

Each phone subscribes separately. **Turn off** removes only this phone's subscription.

### What sends a notification

Settings has three switches that apply everywhere:

- **A chat needs you:** a question (an ask card) waiting for an answer, or a run waiting at an approval gate.
- **A run finished.**
- **A run failed.**

Per chat, the bell in the chat header chooses:

- **Default:** follows the three switches.
- **Following:** also notifies each time the agent finishes a turn in this chat.
- **Muted:** nothing from this chat.

A project's screen has **Mute this project**, which silences every chat in it.

Archon does not notify about a chat you have open on screen, on the phone or on a desktop browser. A newer notification about the same chat or run replaces the older one. Tapping a notification opens that chat or run.

Where the phone supports app badges, the Home Screen icon shows how many chats need you while the app is running.

Notifications cover runs executed by the server, which includes every run started from a chat. A run started with the CLI in a separate process does not notify.

## Offline

The app opens without a connection. When Archon cannot be reached, a banner says so: **You are offline** when the phone has no network, or **Can't reach Archon** when the phone is online but the server does not answer within 10 seconds (a Tailscale or VPN connection is down, or the server is). The last 10 chats you opened can still be read, marked as a saved copy. Sending is off until Archon answers again. What you type is kept as a draft, and the app reconnects by itself.

Saved copies are kept only on installs with web authentication off. With web authentication on, the app keeps no copies on the phone, so it needs the server to open.

## Troubleshooting

- **No Install option, or Turn on never appears.** The page is not on HTTPS, or on iPhone it was not opened in Safari.
- **Settings says push is off on the server.** One or more `ARCHON_VAPID_*` variables are missing or malformed. Settings names which; fix them and restart the server.
- **Test notification never arrives on iPhone.** Open Archon from the Home Screen icon, not a Safari tab, and check that notifications for Archon are allowed in iOS Settings → Notifications.
- **Notifications stopped after a server change.** The VAPID pair changed. Turn push off and on again on each phone.

See [Configuration](/reference/configuration/) for every environment variable and [API](/reference/api/) for the push endpoints.
