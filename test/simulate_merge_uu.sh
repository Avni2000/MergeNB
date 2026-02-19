#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SUITE="02"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --suite)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Missing value for --suite. Expected one of: 02, 03, 04"
        exit 1
      fi
      SUITE="$1"
      shift
      ;;
    --suite=*)
      SUITE="${1#*=}"
      shift
      ;;
    -02)
      SUITE="02"
      shift
      ;;
    -03)
      SUITE="03"
      shift
      ;;
    -04)
      SUITE="04"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--suite <02|03|04>] [-02|-03|-04]"
      exit 0
      ;;
    *)
      echo "Unknown flag: $1"
      echo "Usage: $0 [--suite <02|03|04>] [-02|-03|-04]"
      exit 1
      ;;
  esac
done

if [[ ! "$SUITE" =~ ^(02|03|04)$ ]]; then
  echo "Invalid suite '$SUITE'. Expected one of: 02, 03, 04"
  exit 1
fi

if [[ ! -f out/tests/runIntegrationTest.js ]]; then
  echo "Building integration runner (compile-tests)"
  npm run compile-tests
fi

if [[ ! -f dist/extension.js ]]; then
  echo "Building extension bundle (compile)"
  npm run compile
fi

TEST_ID="manual_${SUITE}"
echo "Launching manual sandbox: ${TEST_ID}"
node out/tests/runIntegrationTest.js --test "${TEST_ID}"
