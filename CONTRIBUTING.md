# Contributing

Thanks for wanting to help. OnCue is maintained by one person, so reviews can
take a while and not every change will be accepted.

## Before you start

- **Bugs:** open an issue with what you did, what you expected, and what
  happened.
- **Features and larger changes:** open an issue first and agree on the
  direction before writing code. A pull request for an undiscussed feature may
  be closed.
- **Small, obvious fixes:** a pull request on its own is fine.
- **Security problems:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Set up

The [README](README.md#try-it-locally) gets you a running copy with no accounts:
`pnpm install`, then `pnpm dev`.

## Making a change

- Solve one problem per pull request.
- Add or update tests with the code.
- Run `pnpm check` and make sure it passes. For anything a user can see or
  click, run `pnpm test:e2e` as well; the [README](README.md#working-on-oncue)
  has its two one-time setup commands.
- Say in the pull request what you ran and what you did not.
- Follow the conventions in [AGENTS.md](AGENTS.md): strict TypeScript, Biome
  formatting, and comments that explain why in a sentence or two.

Please do not:

- commit credentials, tokens, private keys, or `.env` files;
- weaken a security boundary (network, authorization, preview, or bridge
  isolation) to make a test pass;
- add something the project has deliberately deferred, such as billing or
  shared workspaces, without agreeing on it first.

## How changes land

Day-to-day development happens in a separate repository, and this one is
updated from it. An accepted pull request is applied there and arrives here
with the next update, so yours will be closed rather than merged once that
happens.

## Licence

By contributing, you agree that your contribution is licensed under the
[Apache License, Version 2.0](LICENSE), the same as the rest of OnCue.
