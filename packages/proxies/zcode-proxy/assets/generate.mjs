#!/usr/bin/env node
/** The logo PNGs (225x225 RGBA) are the official Z.ai brand mark,
 * exported from https://z-cdn.chatglm.cn/z-ai/static/logo.svg and committed
 * as binary assets. This former generator produced the old placeholder "Z"
 * tile and would overwrite the official mark — it is kept only as a pointer.
 *
 * WARNING: replacing logo-*.png also requires updating the matching
 * branding.logo sha256 digests in ../manifest.json and syncing
 * catalog/official-source/plugins/com.zhipu.zcode/assets/. A digest mismatch
 * breaks scripts/build-proxy-artifacts.mjs ("referenced asset ... digest
 * mismatch"); that omission once forced a revert of the official mark. */
console.error('generate.mjs is retired: logo assets are the official Z.ai mark, edit logo-*.png directly.');
process.exitCode = 1;
