/* Entry point for "node --test tests/". From Node 22 the test runner treats a directory
   argument as a module to load, which resolves to this file; older versions scan the
   directory for *.test.mjs themselves and never look here. Either way the same tests run.
   (tests/e2e.mjs is separate: it needs a browser.  node tests/e2e.mjs) */
import('./sim.test.mjs');
