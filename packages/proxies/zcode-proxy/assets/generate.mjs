#!/usr/bin/env node
/** The logo PNGs (225x225 RGBA) are now the official Z.ai brand mark,
 * exported from https://z-cdn.chatglm.cn/z-ai/static/logo.svg and committed
 * as binary assets. This former generator produced the old placeholder "Z"
 * tile and would overwrite the official mark — it is kept only as a pointer. */
console.error('generate.mjs is retired: logo assets are the official Z.ai mark, edit logo-*.png directly.');
process.exitCode = 1;
