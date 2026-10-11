import { main } from './cli';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => { process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`); process.exit(1); },
);
