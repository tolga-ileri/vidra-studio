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
- **To the provider's media host:** the download request that saves your
  finished output into your archive.
- **To the GitHub API**, only when you click "Check for updates". This
  request contains no personal data.

## Exports

Archive backups (`.vidra`) and prompt exports (`.json`) contain your media,
prompts and generation metadata. They **never** contain credentials. Treat
them as personal files.

## Removing your data

Remove credentials in **Providers → Remove**, delete the archive folder, and
uninstall the app. The uninstaller does not delete your archive folder, so
your videos are kept unless you remove the folder yourself.
