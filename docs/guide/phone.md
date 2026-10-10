# On your phone

Wanigan on your phone through Tailscale: setting it up, and what a phone can and cannot reach. Back to the [README](../../README.md).

Wanigan has a page for your phone: what needs you, answered there; your
sessions, with their terminals, typed into; a new session on any project, with
any account and model; and your boards, with new cards, accepting, approving
and sending back. Your phone reaches your Mac through
[Tailscale](https://tailscale.com), a private network between your own devices,
free for personal use. Nothing is put on the internet, there is nothing to
install from an app store, and there is no Wanigan server in between.

1. Install Tailscale on your Mac and on your phone, and sign in to both with
   the same account.
2. In **Settings › Phone**, choose **Turn on phone access**. If Tailscale still
   needs something (signing in, or HTTPS certificates turned on for your
   network), Settings says what and links to it.
3. Choose **Show a pairing code** and point your phone's camera at the QR code.
   On an iPhone, add Wanigan to your Home Screen (Share › Add to Home Screen),
   open it from there and enter the code: iPhones only send notifications to
   Home Screen apps. Name the phone and tap **Pair**.
4. On the phone, **This phone › Turn on notifications**. Then **Send a test
   notification** from Settings › Phone on your Mac.

What it does:

- Wanigan listens on `127.0.0.1:47832` only, and runs one command, shown before
  you turn it on, so that Tailscale serves it at
  `https://<your-mac>.<your-tailnet>.ts.net/wanigan/` to your own devices:
  `tailscale serve --bg --https=443 --set-path=/wanigan http://127.0.0.1:47832`.
  Anything else you serve with Tailscale is left alone, and **Turn off**
  removes only `/wanigan`.
- A pairing code works once, for ten minutes; after ten wrong codes in a minute
  pairing waits. Each phone gets its own key, kept on the Mac only as a hash.
  **Forget** cuts a phone off at once, open connections included. **Can act**
  off makes a phone read-only.
- A phone never reaches settings, accounts, sign-ins, git, skills, MCP servers,
  files on the Mac, Jev's key or pairing. What it does is in Activity as "You,
  from" the phone's name.
- Notifications go through your phone's push service (Apple's for an iPhone,
  Google's for Chrome, Mozilla's for Firefox), encrypted to your phone so the
  service cannot read them. They say what the Mac's banners say.
- A session started from the phone runs on the Mac, in the project's folder,
  exactly like one started there. A terminal is drawn at the size it has on the
  Mac, scaled to fit; **Fit to this phone** resizes it, on the Mac too.
- While phone access is on, Wanigan's core keeps running with the window
  closed, so your phone can reach it. The Mac has to be awake.
