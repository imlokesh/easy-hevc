# Releasing Easy HEVC

From a clean, up-to-date `main` branch, run:

```bash
bun test
bun run release:patch
```

This bumps the patch version, creates the version commit and tag, and pushes them. The `Release` GitHub Actions workflow tests and builds the tagged code, publishes to npm, and then creates the GitHub release.

## npm authentication

The workflow uses [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) with GitHub OIDC, rather than an `NPM_TOKEN` secret. The npm package must trust:

- Package: `easy-hevc`
- Repository: `imlokesh/easy-hevc`
- Workflow filename: `release.yml`
- Permission: publish
- Environment: none

If this relationship needs to be recreated, sign in to npm with an account that can manage the package and run:

```bash
npx --yes npm@11.20.0 trust github easy-hevc --file release.yml --repo imlokesh/easy-hevc --allow-publish --yes
```

Complete npm's browser verification. Logging in locally does not authenticate GitHub Actions; the trusted publisher relationship is what enables automatic releases.

## Retrying a release

In GitHub Actions, select **Release → Run workflow**, use the workflow from `main`, and enter the existing version tag, for example `v1.0.16`. This uses the current workflow to build the tagged source. The workflow verifies the tag matches `package.json`, skips npm publishing if that version already exists, and completes the GitHub release.

Check that the workflow succeeded and that `npm view easy-hevc version` reports the expected version before announcing a release. npm versions cannot be overwritten; publish a new patch version for code changes.

For a manual fallback, check out the release tag in a clean checkout, install dependencies, run tests, then run `npm login` and `npm publish`. npm may request separate browser verification for publishing.
