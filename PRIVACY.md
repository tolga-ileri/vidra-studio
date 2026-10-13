# Privacy

Vidra Studio is a local desktop application. It has **no accounts, no
telemetry, no analytics and no crash reporting**. There is no Vidra server.

## What stays on your computer

| Data | Where |
| --- | --- |
| Provider API credentials | Windows Credential Manager (OS-protected). Never in the database, logs, backups or exports. |
| Prompts, generation history, settings, cost estimates | Local SQLite database in `%APPDATA%\dev.tolgaileri.vidra\` |
| Generated videos and images | Your archive folder (default `%USERPROFILE%\Videos\Vidra Studio`) |

## What leaves your computer, and only when you act

- **To the AI provider you choose** (Higgsfield, fal.ai, Replicate or Kling AI):
  - your prompt, settings and any reference files you attach, sent when you
    request an estimate or press Generate;
  - your credential, sent as the provider requires.

  Each provider's own privacy policy and terms apply to that data.
- **To the provider's upload endpoint:** reference images you attach to a
  generation, through the provider's documented upload flow, only when you
  attach them. Saved library copies stay in your archive folder.
- **To the provider's media host:** the download request that saves your
  finished output into your archive.
- **To GitHub Releases**, once when Vidra starts and when you click "Check
  for updates", to fetch the signed update manifest (`latest.json`). The
  request contains no personal data. An update downloads only after you
  click "Update now", and it installs only if its signature verifies.

## Exports

Archive backups (`.vidra`) and prompt exports (`.json`) contain your media,
prompts and generation metadata. They **never** contain credentials. Treat
them as personal files.

## Removing your data

Remove credentials in **Providers → Remove**, delete the archive folder, and
uninstall the app. The uninstaller does not delete your archive folder, so
your videos are kept unless you remove the folder yourself.
