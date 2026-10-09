# Brag Plan: certwatch

## What is this app?
certwatch is a private, self-hosted tracker that checks SSL certificate and domain registration expiry dates daily and can send reminders by email and browser push.

## The angle
Keep the quiet reassurance of a tidy workbench: the important dates stay visible, and the next reminder can reach you where you choose. The film opens on the small but costly thing a person can forget, then lets the real dashboard and alert settings do the convincing.

## Hook (first 2-3 seconds)
On a warm paper field, two date slips arrive: “Certificate” and “Registration.” A measured line lands: “Two dates. Easy to forget.” This is framing, not a performance claim.

## Key moments (the middle)
- Show a product dashboard drawn from certwatch's existing dashboard UI: synthetic domains, counts, status pills, and a next expiry date.
- Focus on the actual product copy “A clear view of certificate and registration renewals.” and the daily-check label.
- Show actual alert settings and a sample email/push reminder at a chosen lead time.

## Outro / punchline
The busy dates settle into the certwatch checkmark and wordmark. “Checks run daily.” Clear, calm, practical.

## User flow worth showing
Open the overview → add a domain for SSL and registration checks → choose lead times and email/push channels. The short spot compresses this into dashboard → alert settings → reminder preview.

## Tone
- Preset: polished
- Creative direction: quiet confidence, like the calendar you stop having to carry in your head
- Interpretation: soft green accents, restrained motion, clear holds, and short product-led copy.

## Format: landscape — 1920x1080
## Duration: 20 seconds

## Visual identity (from the project)
- Background: `#f6f8f5` (app canvas; sidebar `#fbfcfa`)
- Accent: `#338461` (brand greens `#438d69` / `#2d6f4e`)
- Text: `#1f302a`
- Display font: Manrope
- Body font: DM Sans
- Strongest visual element: the certwatch dashboard with green/amber/red status markers and clean expiry rows.

## Share copy (draft)
certwatch keeps SSL certificate and domain registration expiry dates in view, with daily checks and reminders by email or browser push.

## Audio direction
- Role: warm bed with sparse UI accents
- Music: `happy-beats-business-moves-vol-12-by-ende-dot-app.mp3`, steady and clean
- Music treatment: 0.18 volume, gentle fade in and out, keep space for the dashboard and closing line
- Music cue guidance: bundled preset `composition/assets/music/happy-beats-business-moves-vol-12-by-ende-dot-app.music-cues.json`; use as optional timing guidance, not a strict grid
- Audio-reactive treatment: subtle, bounded glow breathing on the green mark only, driven by pre-extracted bass/RMS data; no visualizer graphics
- SFX posture: sparse; soft drops for the UI/reveal, one quiet bell on the final mark
- Audio-coupled moments: dashboard enters with a soft drop; alert channels reveal one by one; final wordmark settles on the warm music resolve
- Restraint rule: no alarm sounds, urgency cues, or triumphant overstatement.

## Storyboard

### Scene 1 — The dates — 3s
On a pale sage canvas, two date slips land: Certificate / Registration. Copy: “Two dates. Easy to forget.”
Sequential/interaction: yes — slips arrive in sequence, then line fades in and holds.
Audio intent: soft invitation, not a warning.
Audio-coupled idea: quiet drop on the second slip.
Music: warm steady bed begins low.
Transition mood: soft → Scene 2

### Scene 2 — One view — 6s
Reveal a real certwatch dashboard composition using the current product layout and styling, with invented domain names, dates, status counts, and no real user information. Keep the UI copy “Your domains” and “A clear view of certificate and registration renewals.” Visible rows show both certificate and registration dates.
Sequential/interaction: yes — rows settle in, the next-expiry row gets a restrained green focus.
Audio intent: calm clarity.
Audio-coupled idea: one soft drop as the UI settles.
Music: continue under the interface.
Transition mood: clean → Scene 3

### Scene 3 — A timely nudge — 6s
Show the real alert settings structure: SSL and registration lead times, email notifications, push notifications, and a seven-day certificate reminder preview. Add the factual qualifier “When configured” beside delivery channels. Copy: “Choose when and where we’ll reach you.”
Sequential/interaction: yes — lead time, email, then push reveal; hold the sample notice long enough to read.
Audio intent: reassuring, matter-of-fact.
Audio-coupled idea: two subtle UI ticks, one per channel.
Music: steady, unobtrusive.
Transition mood: soft → Scene 4

### Scene 4 — The close — 5s
The UI recedes to a clean canvas. Brand checkmark and certwatch wordmark resolve, with “Checks run daily.” below.
Sequential/interaction: yes — mark draws/settles, wordmark and line follow.
Audio intent: confident, quiet finish.
Audio-coupled idea: a gentle bell at the mark's settled state.
Music: warm fade at the end.
Transition mood: none

**Music mood for this video:** warm, steady, understated
**Audio summary:** One low, friendly music bed carries the spot; a few soft interface accents mark the useful moments without suggesting an incident.

## Product claims / production notes
- “Checks run daily” is sourced from the dashboard and README scheduler behavior.
- SSL checks read the public certificate on port 443; registration expiry is looked up over RDAP where registries publish the date.
- Threshold reminders and email/push delivery are configurable; email requires Resend configuration, and browser push requires browser permission plus HTTPS (or localhost).
- No automatic renewal or uptime guarantee is claimed.
- All domains and dates in the film are synthetic. No production database, push-key file, secrets, email addresses, or personal information are used.


## Music credit
“Happy Beats & Business Moves Vol. 12” by Sascha Ende — ende.app, CC BY 4.0. Full attribution is in `credits.md` and `share-copy.txt`.
