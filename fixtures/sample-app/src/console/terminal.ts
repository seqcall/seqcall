import { report } from './report';

/** Module-level entry point: the Output implementation is an object literal owned by this module. */
report(['a', 'b'], {
  line: (text: string) => console.log(text),
});
