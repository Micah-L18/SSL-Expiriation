# HyperFrames Composition Brief: certwatch

## Objective
Create a polished, quiet-confidence launch film for certwatch using its existing green checkmark identity and actual app interface patterns.

## Output
- Composition directory: `branding/certwatch-brag-2026-10-08/composition/`
- Rendered video: `branding/certwatch-brag-2026-10-08/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 20 seconds

## Source Material
- Project root: supplied workspace (local only)
- Primary files read: `app/README.md`, `app/public/index.html`, `app/public/style.css`, `app/public/app.js`, `app/lib/checks.js`, `app/lib/monitor.js`, `app/lib/alerts.js`, `app/lib/notify.js`
- Product name: certwatch
- Strongest claim: “A clear view of certificate and registration renewals.”
- UI moment: dashboard with monitored domains and expiry status, followed by alert settings and reminder preview.
- Copy to preserve: “A clear view of certificate and registration renewals.” / “Choose when and where we’ll reach you.” / “Checks run daily.”

## Creative Direction
- Tone preset: polished
- Creative direction: quiet confidence; expiry dates remain visible and reminders can reach the user on chosen channels
- Interpretation: gentle, precise motion, real product surfaces, generous holds, no alarmist or heroic language.
- Angle: two easy-to-forget dates become a clear view and a configurable nudge.
- Hook: two date slips (Certificate / Registration), then “Two dates. Easy to forget.”
- Outro: certwatch identity and “Checks run daily.”
- Avoid: generic SaaS language, unsupported reliability claims, automatic renewal claims, real account data, or unrelated visual redesign.

## Visual Identity
- Background: `#f6f8f5`
- Sidebar: `#fbfcfa`
- Text: `#1f302a`
- Accent: `#338461` / `#438d69`
- Display font: Manrope
- Body font: DM Sans
- Visual references: `app/public/index.html`, `app/public/style.css`, `app/public/icon.svg`
- The visual UI is recreated from current product markup and styling. Demo domains/dates are fictional.

## Storyboard
Use the scene storyboard in `brag-plan.md` as the creative contract.

1. The dates — 3s — two reminder slips and a short forgetfulness hook.
2. One view — 6s — actual dashboard structure with synthetic domains, dates, and statuses.
3. A timely nudge — 6s — alert lead times, email/push settings, sample reminder with configuration qualifier.
4. The close — 5s — established checkmark, certwatch, daily-check line.

## Audio
- Audio role: warm music bed with sparse interface accents.
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`
- Music treatment: 0.18 volume, soft fade, retain end space for logo settle.
- Music cue guidance: bundled cue JSON at `assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`; natural readability takes priority.
- Audio-reactive treatment: subtle mark glow breathing driven by pre-extracted per-frame bass/RMS values from `assets/music/audio-data.json`.
- Audio-coupled moments: second date-slip drop, product UI settle, gentle closing bell.
- SFX: soft UI drop and a restrained bell, copied into composition assets. Music attribution is in `credits.md` (CC BY 4.0).
- SFX analysis: Brag bundled sfx library; choose lower-risk soft cues.

## HyperFrames Instructions
Implement one standalone HyperFrames composition with a single seek-safe paused GSAP timeline registered to the root id. Use local audio and font-safe system fallbacks. Keep the product surface legible and truthful. Run `npx hyperframes check`, render locally, and verify the finished MP4, timing, opening poster, and key still frames. All demo data is synthetic. No production database or key material is used.
