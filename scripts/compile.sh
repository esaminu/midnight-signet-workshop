#!/bin/sh
set -e
cd "$(dirname "$0")/.."
OUT="${OUT:-contract/managed}"
mkdir -p "$OUT"
COMPACT_PATH=node_modules compact compile +0.33.0-rc.2 "$@" --feature-zkir-v3 \
  contract/workshop.compact "$OUT/workshop"
rm -rf "$OUT/SignetNotifier"
ln -sfn ../../node_modules/@sig-net/midnight-contract/dist/managed "$OUT/SignetSigner"
