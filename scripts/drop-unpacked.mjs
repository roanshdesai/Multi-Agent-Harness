// After `npm run desktop:mac`: remove the unpacked app electron-builder leaves in release/,
// so Spotlight shows only the copy installed in Applications. The .dmg stays.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
const dir = new URL("../release/", import.meta.url).pathname;
for (const name of readdirSync(dir, { withFileTypes: true })) {
  if (name.isDirectory() && /^mac(-arm64|-universal|-x64)?$/.test(name.name)) {
    rmSync(join(dir, name.name), { recursive: true, force: true });
    console.log(`removed release/${name.name} (the .dmg has the app)`);
  }
}
