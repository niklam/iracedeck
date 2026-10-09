// Restores the x.y.z manifest Version inside the packed Ulanzi archive
// (issue #1298). `release-pack.yml` runs it after `@elgato/cli pack`, which
// pads every manifest Version to four parts on its way into the archive — the
// one form the Ulanzi marketplace refuses. It fails the job unless the archive
// reads back exactly the version it was given.
//
// Usage: node scripts/stamp-ulanzi-package-version.mjs <archive> <version>
import { readFileSync, writeFileSync } from "node:fs";

import { ULANZI_MANIFEST_VERSION } from "./lib/manifest-version.mjs";
import { readPackedManifestVersion, setPackedManifestVersion } from "./lib/packed-manifest.mjs";

const [archive, version] = process.argv.slice(2);
if (!archive || !version) {
  console.error("Usage: node scripts/stamp-ulanzi-package-version.mjs <archive> <version>");
  process.exit(1);
}
if (!ULANZI_MANIFEST_VERSION.test(version)) {
  console.error(`Refusing to stamp "${version}": the Ulanzi marketplace accepts only x.y.z`);
  process.exit(1);
}

const before = readPackedManifestVersion(readFileSync(archive));
writeFileSync(archive, setPackedManifestVersion(readFileSync(archive), version));

const after = readPackedManifestVersion(readFileSync(archive));
if (after !== version) {
  console.error(`${archive} reads back Version "${after}", expected "${version}"`);
  process.exit(1);
}
console.log(`${archive}: manifest Version ${before} → ${after}`);
