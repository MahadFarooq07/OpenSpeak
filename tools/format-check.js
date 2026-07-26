'use strict';

/**
 * Standalone check for the deterministic formatter.
 *
 *   node tools/format-check.js
 *
 * Runs in plain Node — no Electron, no API key, no microphone. The cases below
 * are the real dictation outputs that motivated format.js, plus the edge cases
 * it must NOT mangle.
 */

const { normalize } = require('../src/main/providers/format');

const CASES = [
  {
    name: 'spoken count-off becomes a list',
    input: 'One bread, two milk, three bananas',
    expect: '1. Bread\n2. Milk\n3. Bananas'
  },
  {
    name: 'spoken count-off becomes a list, punctuation and all',
    input: 'One bread, two milk, three bananas.',
    expect: '1. Bread\n2. Milk\n3. Bananas'
  },
  {
    name: 'spoken count-off keeps its lead-in',
    input: 'Create a grocery list, one bread, two milk, three bananas',
    expect: 'Create a grocery list:\n1. Bread\n2. Milk\n3. Bananas'
  },
  {
    name: 'ordinals count off too',
    input: 'first wake up, second make coffee, third leave',
    expect: '1. Wake up\n2. Make coffee\n3. Leave'
  },
  {
    name: 'a flowing sentence is not a list',
    input: 'I need to grab bread, milk and bananas on the way home',
    expect: 'I need to grab bread, milk and bananas on the way home.'
  },
  {
    name: 'quantities and measures stay as prose',
    input: 'It took two hours, three of them helped, one thing went wrong',
    expect: 'It took two hours, three of them helped, one thing went wrong.'
  },
  {
    name: 'only two spoken markers is not enough',
    input: 'One bread and two milk',
    expect: 'One bread and two milk.'
  },
  {
    name: 'lead-in unglued from the first item, mic check collapsed',
    input: 'Hello, hello, hello 1. Bread\n2. Milk\n3. Bananas',
    expect: 'Hello.\n1. Bread\n2. Milk\n3. Bananas'
  },
  {
    name: 'inline list broken onto lines, colon kept, items capitalised',
    input: 'Create a grocery list: 1. bread 2. milk 3. bananas!',
    expect: 'Create a grocery list:\n1. Bread\n2. Milk\n3. Bananas!'
  },
  {
    name: 'list with no lead-in',
    input: '1. bread 2. milk 3. bananas',
    expect: '1. Bread\n2. Milk\n3. Bananas'
  },
  {
    name: 'sloppy numbering is renumbered',
    input: 'Steps 1) first thing 2) second thing 3) third thing',
    expect: 'Steps:\n1. First thing\n2. Second thing\n3. Third thing'
  },
  {
    name: 'bullets normalised and capitalised',
    input: '* bread\n• milk\n- bananas',
    expect: '- Bread\n- Milk\n- Bananas'
  },
  {
    name: 'decimals are not mistaken for list markers',
    input: 'It costs 1. 50 and weighs 2. 5 kilos',
    expect: 'It costs 1. 50 and weighs 2. 5 kilos.'
  },
  {
    name: 'a lone number mid-sentence is not a list',
    input: 'Call me back on 3. I will be free then',
    expect: 'Call me back on 3. I will be free then.'
  },
  {
    name: 'emphasis repetition is preserved',
    input: 'No, no, no, that is not what I meant',
    expect: 'No, no, no, that is not what I meant.'
  },
  {
    name: 'stutter is collapsed',
    input: 'the the the report is ready',
    expect: 'The report is ready.'
  },
  {
    name: 'raw mode changes nothing structural',
    input: 'create a grocery list 1. bread 2. milk',
    opts: { mode: 'raw' },
    expect: 'create a grocery list 1. bread 2. milk'
  },
  {
    name: 'punctuation can be switched off',
    input: 'this sentence has no full stop',
    opts: { autoPunctuate: false },
    expect: 'This sentence has no full stop'
  },
  {
    name: 'trailing space only on single-line output',
    input: 'keep going',
    opts: { trailingSpace: true },
    expect: 'Keep going. '
  },
  {
    name: 'empty stays empty',
    input: '   ',
    expect: ''
  }
];

let passed = 0;
const failures = [];

for (const c of CASES) {
  const got = normalize(c.input, c.opts || {});
  if (got === c.expect) {
    passed += 1;
  } else {
    failures.push({ ...c, got });
  }
}

const show = (s) => JSON.stringify(s);

for (const f of failures) {
  console.log(`\nFAIL  ${f.name}`);
  console.log(`  in    ${show(f.input)}`);
  console.log(`  want  ${show(f.expect)}`);
  console.log(`  got   ${show(f.got)}`);
}

console.log(`\n${passed}/${CASES.length} formatter cases passed.`);
if (failures.length) {
  console.log('\nPaste the failures above and they can be fixed directly.');
  process.exitCode = 1;
}
