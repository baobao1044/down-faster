# Privacy Policy

Down Faster does not collect, store, or transmit any personal data.

The extension processes downloads entirely on-device. It reads download URLs and file data only to perform the download the user initiated. No telemetry, no analytics.

## Ad networks

The popup and manager page show a small ad card.

- In this release (0.3.0) the ad is a **house ad** — static content pointing at the project's own GitHub page. It makes **no network request**; the only hardcoded URL is `https://github.com/baobao1044/down-faster`, used as a plain link.
- The extension is **architecture-ready** for a network ad provider (such as EthicalAds, ethicalads.net), but that path is **disabled by default**. If it is enabled in a future release, it will fetch ad creative (text, image, link) from the configured endpoint with `credentials: 'omit'` — no cookies, no tracking identifiers are sent to the ad endpoint. The ad endpoint domain will be disclosed here before any such release.

## Support link (Ko-fi)

The welcome page and settings tab show a Ko-fi "Buy me a coffee" button (`ko-fi.com/F8U8260QJ8`).
Clicking it opens the Ko-fi page in a new tab. The button image is loaded from `ko-fi.com`
(no cookies, no tracking from the extension). The extension sends **no data** to Ko-fi.

See the full privacy documentation at:
https://github.com/baobao1044/down-faster/blob/main/PRIVACY.md
