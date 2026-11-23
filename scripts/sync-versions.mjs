import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

for (const file of ['extension.toml', 'Cargo.toml']) {
  const content = readFileSync(file, 'utf8');
  writeFileSync(file, content.replace(/^version = ".*"/m, `version = "${version}"`));
}

if (existsSync('Cargo.lock')) {
  const lock = readFileSync('Cargo.lock', 'utf8');
  writeFileSync(
    'Cargo.lock',
    lock.replace(/(name = "zed[-_]knip"\r?\nversion = ")[^"]+(")/, `$1${version}$2`)
  );
}
