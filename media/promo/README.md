# Vidra Studio media kit (English)

Every image and video here is built from **real screenshots and a real screen
capture** of Vidra Studio v0.1.0, using the original logo in
`branding/vidra-mark.svg`. The app ran with an isolated demo profile against a
local mock provider, so the media in the UI is generated test footage and no
paid API calls were made. Each asset carries that label.

| File | Size | Use |
| --- | --- | --- |
| `vidra-launch-poster.png` / `.jpg` | 1080×1350 | Launch poster / feed post |
| `vidra-github-social-preview.png` / `.jpg` | 1280×640 | GitHub social preview (Settings → Social preview) |
| `vidra-linkedin-x-banner.png` / `.jpg` | 1500×500 | LinkedIn / X header banner |
| `vidra-instagram-story.png` / `.jpg` | 1080×1920 | Instagram story / vertical announcement |
| `vidra-studio-promo.mp4` | 1440×900, 63 s, H.264 | Promo / demo video (English UI) |
| `vidra-studio-promo-poster.jpg` | 1440×900 | Video poster frame |

To regenerate the assets:

1. Build the e2e app: `pnpm --filter @vidra/desktop tauri build --debug --no-bundle --features e2e-mock`
2. Capture the English demo. From `apps/desktop`, run `DEMO_EN_ONLY=1 npx playwright test -c playwright.demo.config.ts`
3. Render the assets: `node scripts/promo/render.mjs` (needs ffmpeg)

No provider logos are used. Provider names appear only where the real UI shows them.
