### This build is not notarised

It is signed only ad-hoc, so macOS will say **"Apple could not verify Wanigan is
free of malware."** That is the expected message for an app built without an
Apple Developer account — not a warning about this particular download.

To open it once:

1. Drag **Wanigan** to Applications and try to open it.
2. Open **System Settings → Privacy & Security**.
3. Scroll to Security and choose **Open Anyway** beside the Wanigan message.

macOS remembers the decision. On macOS 15 and later, right-click → Open no
longer clears this; the Privacy & Security path is the one that works.

Prefer to avoid that entirely? Build it yourself from this tag:

```bash
nvm use && npm ci && npm run dist:mac:arm64
```
