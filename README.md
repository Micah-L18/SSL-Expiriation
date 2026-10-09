# SSL-Expiriation

A self-hosted tracker for SSL certificate expiry and domain registration expiry,
built for Lachie. It checks each domain daily and sends an email and/or a push
notification as an expiry gets close. Single user, one password.

## What's in here

| Folder | Contents |
| --- | --- |
| `app/` | The tracker itself: Node.js backend, web UI and tests. |
| `concepts/` | The clickable HTML concept (landing page and app) the build was based on. |
| `branding/` | The branding video, its still, and the composition source it was rendered from. |

## Setup

See [app/README.md](app/README.md) for install, configuration and running.

## Notes

- `app/test/fixtures/localhost-key.pem` is a self-signed private key for
  `localhost`, used only by the tests. It is committed on purpose and protects
  nothing.
- Runtime data (`app/data/`, which holds the database and push keys) and `.env`
  are never committed.

## Credits

- Music in the branding video: "Happy Beats & Business Moves Vol. 12" by Sascha
  Ende, from [ende.app](https://ende.app/en/song/12881-happy-beats-business-moves-vol-12),
  licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
- UI sounds: Kenney, CC0.

Full credits are in
[branding/certwatch-brag-2026-10-08/credits.md](branding/certwatch-brag-2026-10-08/credits.md).

## Licence

All rights reserved. No licence is granted to use, copy, modify or distribute
this project. The third-party audio credited above remains under its own
licence.
