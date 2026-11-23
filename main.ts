// The program the harness runs: node /bot/main.ts. It reads /input/cases.json (an array of { id, input }), answers
// each case on its own with solve.js's run, and writes /output/answers.json (the answers, in case order). Outside a
// container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output. The V8 flag is set before
// solve.js loads, the way the reference entry does: this workload builds many short-lived strings, and the default
// incremental marker is not the bottleneck worth paying for here.

import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-incremental-marking');

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const { run } = await import('./solve.js');

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const answers = new Array(cases.length);
for (let i = 0; i < cases.length; i++) answers[i] = run(cases[i].input);

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
