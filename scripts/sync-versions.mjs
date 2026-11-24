import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const isCheck = process.argv.includes('--check');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const mismatched = [];

const update = (file, content, next) => {
  if (next === content) return;
  if (isCheck) mismatched.push(file);
  else writeFileSync(file, next);
};

for (const file of ['extension.toml', 'Cargo.toml']) {
  const content = readFileSync(file, 'utf8');
  update(file, content, content.replace(/^version = ".*"/m, `version = "${version}"`));
}

if (existsSync('Cargo.lock')) {
  const lock = readFileSync('Cargo.lock', 'utf8');
  update(
    'Cargo.lock',
    lock,
    lock.replace(/(name = "zed[-_]knip"\r?\nversion = ")[^"]+(")/, `$1${version}$2`)
  );
}

if (mismatched.length > 0) {
  console.error(`Version mismatch in ${mismatched.join(', ')} (expected ${version})`);
  process.exit(1);
}
