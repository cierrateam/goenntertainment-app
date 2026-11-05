# Handoff 001 — Land the SDK 58 work and sync with main

Model: opus · Effort: high · Plan mode: off
Start: claude --model opus --effort high

## Why

The working tree on `feat/marktplatz-club` holds three finished but uncommitted pieces of work, the branch has two local commits that were never pushed, and it is 9 commits behind `origin/main`. Nothing new gets built on top of that. This handoff lands it as one reviewed PR.

The first TestFlight build is made from this branch as soon as it is pushed. EAS uploads the working tree as it is, so the build should match a pushed commit. That's also why the branch carries two `app.json` settings for the store build (commit 5).

## What is already in the working tree (verify, don't redo)

1. **Expo SDK 57 → 58**: `package.json`, `package-lock.json`; `app.json` plugins (`expo-font`, `expo-image`, `expo-status-bar`, `expo-web-browser`); RN 0.88 strict types (`ViewInstance`, `ScrollViewInstance`, `TextInputInstance`) in `src/app/chat.tsx`, `src/components/home-background.tsx`, `src/components/ui/{form-scroll-context.ts,keyboard-form.tsx,rail.tsx,text-field.tsx}`; masked-view type cast in `brand-gradient-text.tsx`; `ref` left out of `TabButton` in `app-tabs.tsx`; `headerTransparent: false` in `src/app/_layout.tsx` and `src/app/(auth)/_layout.tsx` (iOS 26); `.github/audit-allowlist.json` entries for the SDK 58 tooling advisories.
2. **Backend default → https://goe4fun.de**: `.env.example`, `eas.json` (preview + production), comment in `src/constants/config.ts`, `scripts/dev-up.ps1`, `.claude/commands/wlan.md`, the address paragraphs in `README.md` and `deploy/README.md`.
3. **Stamp card**: `src/components/stamp-card.tsx` lays the fields out in two fixed rows (six fields landed in the first row on phones ≥ 390 pt); `src/app/checkin.tsx` keeps the full card visible during the celebration, then shows the next card, golden when it is one.

Plus the local commits f106878 (app icon and splash with Gönni) and 6650f15 (Android keystore and EAS credentials.json never committed).

## Goal — done when

- Branch `chore/expo-sdk-58`, created from the current HEAD (so it keeps f106878 and 6650f15), holds the work as five commits plus one merge of `origin/main`:
  1. the SDK 58 upgrade (topic 1),
  2. backend default goe4fun.de (topic 2, including the existing README.md and deploy/README.md changes),
  3. stamp card (topic 3),
  4. docs: AGENTS.md and the README "Further reading" link point to `https://docs.expo.dev/versions/v58.0.0/` instead of v57, plus the new folder `docs/handoffs/` (its `README.md` and this file). Make the link edits after commit 2, so README.md needs no partial staging.
  5. store-build settings in `app.json` (Shawn's decisions of 2026-11-03): `expo.name` becomes `"Goe4FUN"` (the name under the app icon; EAS also uses it as the App Store Connect app name when it creates the app), and `expo.ios.config.usesNonExemptEncryption` is set to `false` (the app only uses encryption built into iOS, i.e. HTTPS and the Keychain, so App Store Connect stops asking the export-compliance question for every build). Make these edits after commit 1, so `app.json` needs no partial staging. Keep `slug` (it ties the app to the EAS project), `scheme`, the bundle id and the `package.json` name unchanged.
- Conventional Commits with German subject lines, like the recent commits in `git log`.
- Every check below passes, the branch is pushed, and a PR into `main` is open.

## Steps

1. Make sure no other Claude Code session is still editing this folder. `git fetch origin`.
2. Compare the working tree with the three topics (`git status`, `git diff --stat`). If a tracked change fits none of them, stop and list it in the report instead of committing it.
3. `git switch -c chore/expo-sdk-58`, then the five commits. Before each commit check `git diff --cached --stat`: a whole-file rewrite means line endings went wrong; the repo stores LF, so fix that before committing.
4. `git merge origin/main`. Expect conflicts only in `README.md` and `deploy/README.md`: keep both sides (main brings Cloudflare, Microsoft Graph mail and metadata-endpoint changes; ours changes the API-address paragraphs).
5. Run the checks. Fix what fails within the scope of this PR; anything bigger goes into the report as an open item.
6. Push with upstream and open a PR into `main` (`gh` if installed, otherwise print the compare URL). PR body: the three topics and the store-build settings, the checks and results, the Dependabot PRs this supersedes (the expo-sdk group, expo-constants 58.0.9, react-native-gesture-handler 3.3.0; don't close them), and the manual follow-ups below.

## Checks

From the README table "Tests and checks", with `EXPO_NO_TELEMETRY=1` and `EXPO_OFFLINE=1` set for every Expo command:

- `npm test`
- `npx tsc --noEmit`
- `npm run lint`
- `npx expo install --check`
- `npx expo export --platform android` (bundle smoke test; the output goes to the git-ignored `dist/`)
- `npx expo config --type introspect --json`: `ios.infoPlist.CFBundleDisplayName` is `Goe4FUN` and `ios.infoPlist.ITSAppUsesNonExemptEncryption` is `false`
- `npm run test:tooling`
- `node scripts/ci/check-repo.mjs`
- `node scripts/ci/check-mirrors.mjs`
- `node scripts/ci/check-workflows.mjs .github/workflows --ci-env deploy/ci.env`
- `node scripts/ci/audit.mjs npm .`
- The merge brings API and deploy changes from main: run the API suite only against a throwaway MySQL 8.4 as in README "API tests and MySQL", never against the dev database. If none is available, say so; CI covers it together with the server and deploy suites.

## Rules

- AGENTS.md applies.
- Stage only tracked files that belong to the three topics, plus the docs commit (AGENTS.md, README.md, `docs/handoffs/`) and the `app.json` edits of commit 5. Leave every other untracked file and folder untouched.
- No behaviour changes beyond the three topics and the two `app.json` settings; don't touch `api/` or `server/` except to resolve the merge.
- Don't force-push, don't rebase anything already pushed, don't merge the PR, don't append to `change/human.md` or `change/ai.md`.

## Manual follow-ups for Shawn (also in the PR body)

- TestFlight, once the branch is pushed: run `npx eas-cli@latest build --platform ios --profile production --auto-submit` on this branch. Not `npx testflight`: it starts `npx` without a shell, which fails on Windows.
- SDK 58 changes native code: build a new development client (`eas build --profile development --platform android`, and iOS if used) before testing on the phone.
- Test on the phone: check-in with a full card (celebration, then the next or golden card), screen headers on iOS 26, forms with the keyboard open, the tab bar.

## Report back (end with exactly this block)

- Branch + PR URL
- Commits: hash — subject
- Merge conflicts: files and how they were resolved
- Checks: command → pass/fail (with counts)
- Not run or unverified, and why
- Anything unexpected in the working tree
- Open questions or decisions for Shawn
