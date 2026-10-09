# certwatch branding video — verification

## Deliverables
- `brag.mp4` — final 20-second landscape film.
- `brag.jpg` — selected dashboard poster, also baked into video frame 0.
- `concept-short.md` — concept and timed short outline.
- `brag-plan.md` — creative rationale, claim grounding, storyboard, and music direction.
- `composition-brief.md` — HyperFrames production brief.
- `composition/index.html` and `composition/assets/` — editable composition, local music/SFX, cue metadata, and extracted audio-reactive data.
- `share-copy.txt` and `credits.md` — post-ready caption with music attribution.
- `source/certwatch-style.css` and `source/asset-provenance.md` — design reference and synthetic-data provenance.

## Render
- MP4: H.264 video + AAC stereo audio, 1920×1080, 30 fps, 600 frames, 20.000 s.
- File size: 1,168,352 bytes.
- Poster: JPEG, 1920×1080, selected at the settled dashboard frame (5.6 s) and applied to frame 0.

## Checks
- `npx hyperframes check`: passed; 0 lint errors, 0 runtime errors, 0 layout issues, 0 motion errors, and 157/157 text checks passed WCAG AA. Four non-blocking lint warnings note that each self-contained scene section could be a sub-composition.
- `npx hyperframes snapshot`: storyboard frames visually reviewed for dashboard, alert settings, and end card. Final frame-zero image reviewed after poster bake; synthetic dashboard values are coherent.
- Full MP4 decoded with FFmpeg without errors. `ffprobe` confirmed video/audio streams and output specs above.
- Local HyperFrames Studio returned HTTP 200 at `http://localhost:3002/` during review.

## Claim and data review
- Daily checks, certificate/registration expiry tracking, reminder thresholds, email delivery, and browser push are grounded in the README and implementation. RDAP support may vary by registry. Email requires server configuration; browser push requires a secure context and permission.
- Domains use the reserved `.example` suffix; dates/counts are fictional. No app database, push key file, secrets, emails, or personal information were opened or included.
- No application functionality was changed for this deliverable.

## Music attribution
“Happy Beats & Business Moves Vol. 12” by Sascha Ende — ende.app, CC BY 4.0. Commercial use is allowed with attribution per [the track page](https://ende.app/en/song/12881-happy-beats-business-moves-vol-12). Attribution is included in `share-copy.txt` and `credits.md`.
