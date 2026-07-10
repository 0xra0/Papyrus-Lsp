#!/usr/bin/env node
'use strict';
/**
 * Fetch the vanilla Starfield script sources + the Papyrus compiler this server
 * ships against, into `_vanilla-sf-scripts/`.
 *
 * This is what makes the server independent of a Creation Kit install: the .psc
 * sources, Starfield_Papyrus_Flags.flg, and PapyrusCompiler.exe all come from
 * one public repo rather than a local CK checkout.
 *
 * Run once after cloning:  npm run fetch-vanilla
 */
const { spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const REPO = process.env.PAPYRUS_LSP_VANILLA_REPO
  || 'https://github.com/rux616/modding-sf1-scripts-vanilla';
const DEST = path.join(__dirname, '..', '_vanilla-sf-scripts');

if (fs.existsSync(path.join(DEST, 'Scripts', 'Source'))) {
  console.log(`Already present: ${DEST}\nDelete it to re-fetch.`);
  process.exit(0);
}

if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) {
  console.error('git is required to fetch the vanilla scripts.');
  process.exit(1);
}

console.log(`Cloning ${REPO}\n     -> ${DEST}`);
const r = spawnSync('git', ['clone', '--depth', '1', REPO, DEST], { stdio: 'inherit' });
if (r.status !== 0) {
  console.error('\nClone failed. Fetch the sources manually and place them at:\n  ' +
                path.join(DEST, 'Scripts', 'Source'));
  process.exit(1);
}

console.log('\nDone. Now run `npm run rebuild-db` to cache the type index.');
