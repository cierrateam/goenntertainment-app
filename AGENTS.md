# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v58.0.0/ before writing any code.

## Security rules

These rules apply to every change, whether a person or an AI assistant writes it.

- Never log secrets, passwords, tokens, reset codes or 2FA codes, not even in development. Mail
  goes to the local mail catcher (README, "Mail in development"), never to the log mailer.
- Every route needs authentication, authorisation, input limits, a rate limit and a test.
- One backend owns each path: Laravel (`api/`) serves every route the app calls
  (`src/domain/laravel-routes.test.ts` fails otherwise). The former Node backend (`server/`) is
  not deployed; its routers come from `createRouter()` (`server/src/router.js`).
- Every kind of user content needs moderation and a report path.
- No personal data in fixtures, docs or commits: use obviously fake values (`example.invalid`
  addresses, made-up passwords), never a real address or a working credential.
- Run all test suites before committing; the commands are in the README section
  [Tests and checks](README.md#tests-and-checks). The API suite needs MySQL 8.4 loaded from
  `server/schema.sql` ([API tests and MySQL](README.md#api-tests-and-mysql)); its database tests
  fail without it. Never make them pass another way (sqlite, a schema built in a test,
  `RefreshDatabase`): `server/schema.sql` is the only schema.
