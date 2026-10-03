#!/usr/bin/env bash
# Publishes the built extension (bundle + .vsix) as an npm package on GitHub Packages.
# GitHub Packages needs a scoped name; the extension's own id (publisher.name) stays unchanged
# because the name is only changed here, inside the CI workspace.
set -euo pipefail
npm pkg set name="@gauravgupta0612/silverlake-ibmi"
npm pkg set publishConfig.registry="https://npm.pkg.github.com"
npm pkg delete dependencies   # everything is bundled into dist/extension.js
npm pkg set "files[0]=dist" "files[1]=media" "files[2]=syntaxes" "files[3]=snippets" \
  "files[4]=language-configuration*.json" "files[5]=*.vsix" "files[6]=FEATURES.md" "files[7]=CHANGELOG.md"
VERSION=$(node -p "require('./package.json').version")
if npm view "@gauravgupta0612/silverlake-ibmi@${VERSION}" version >/dev/null 2>&1; then
  echo "Version ${VERSION} is already published — skipping."
  exit 0
fi
npm publish
