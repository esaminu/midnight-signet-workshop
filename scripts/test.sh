#!/bin/sh
cd "$(dirname "$0")/.." || exit 1
part="${1:-}"
case "$part" in
  "") files="tests" ;;
  [1-3]) files="tests/part$part.test.ts" ;;
  part[1-3]) files="tests/$part.test.ts" ;;
  *) echo "usage: yarn test [1|2|3]"; exit 1 ;;
esac
if ! out=$(OUT=contract/managed-test sh scripts/compile.sh --skip-zk 2>&1); then
  echo "$out"
  echo "\ncontract/workshop.compact does not compile: fix the error above first."
  exit 1
fi
WORKSHOP_MANAGED=contract/managed-test exec vitest run $files
