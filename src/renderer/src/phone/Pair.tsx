// Pairing this phone with the code on the Mac (Settings › Phone).
//
// An iPhone keeps a Home Screen app's storage apart from Safari's, so pairing
// in Safari would not carry over. Opened from the QR code in Safari on an
// iPhone, this says to add Wanigan to the Home Screen and enter the code there,
// and keeps the code unspent; elsewhere the QR code fills in the code, and the
// phone is named before it pairs.
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui';
import type { PhoneLink } from './bridge';

function defaultName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/Android/.test(ua)) return 'Android phone';
  return 'Phone';
}

const onIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
/** Another browser on an iPhone: the camera opens a QR code in whichever browser is the default. */
function otherIosBrowser(): string | null {
  const ua = navigator.userAgent;
  return /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge' : null;
}
const standalone = (): boolean => (navigator as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;

export function Pair({ link, onPaired }: { link: PhoneLink; onPaired: () => void }) {
  const fromQr = /[#&]pair=([A-Za-z0-9-]{9})/.exec(location.hash)?.[1]?.toUpperCase() ?? null;
  const homeScreenFirst = !!fromQr && onIos() && !standalone();
  const [code, setCode] = useState(fromQr ?? '');
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = async (with_: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await link.pair(with_, name);
      history.replaceState(null, '', location.pathname);
      onPaired();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent): void => { e.preventDefault(); void pair(code); };

  if (homeScreenFirst) {
    const other = otherIosBrowser();
    return (
      <section className="phone-pair" aria-labelledby="pair-title">
        <img className="phone-pair-icon" src="phone-icon-180.png" alt="" width={72} height={72} />
        <h1 id="pair-title">Add Wanigan to your Home Screen</h1>
        {other ? (
          <>
            {/* iOS 17 and later open an x-safari-https address in Safari, whatever the default browser. */}
            <a className="btn btn-primary btn-m phone-open-safari" href={`x-safari-${location.href}`}>Open in Safari</a>
            <p className="faint small">
              This opened in {other}. Safari is the surest way to add Wanigan to your Home Screen with notifications. To stay
              in {other}, tap <strong>Share</strong> in the address bar, then <strong>Add to Home Screen</strong>.
            </p>
          </>
        ) : null}
        <ol className="phone-steps">
          <li>{other ? 'In Safari, tap' : 'Tap'} <strong>Share</strong> {other ? 'at the bottom' : 'below'}, then <strong>Add to Home Screen</strong>.</li>
          <li>Open <strong>Wanigan</strong> from your Home Screen.</li>
          <li>Enter this code there: <strong className="phone-code">{fromQr}</strong></li>
        </ol>
        <p className="faint small">The code works once, for ten minutes. On an iPhone, notifications only reach Home Screen apps.</p>
        <Button tone="quiet" disabled={busy} onClick={() => void pair(fromQr!)}>Pair in this browser instead</Button>
        {error ? <p className="error-text" role="alert">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="phone-pair" aria-labelledby="pair-title">
      <img className="phone-pair-icon" src="phone-icon-180.png" alt="" width={72} height={72} />
      <h1 id="pair-title">Pair with your Mac</h1>
      <p>{fromQr ? 'Name this phone, then pair it with your Mac.' : 'On your Mac, open Wanigan › Settings › Phone, and enter the code shown under the QR code.'}</p>
      <form onSubmit={submit} className="phone-form">
        <label>
          <span>Code</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EF23" autoCapitalize="characters" autoComplete="one-time-code" spellCheck={false} maxLength={9} required />
        </label>
        <label>
          <span>This phone’s name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
        </label>
        <Button type="submit" tone="primary" disabled={busy || code.length < 9}>{busy ? 'Pairing…' : 'Pair'}</Button>
      </form>
      {error ? <p className="error-text" role="alert">{error}</p> : null}
    </section>
  );
}
