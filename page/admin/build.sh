#!/bin/sh
# Builds the preview page against the shadcn-admin model and its own components.
set -e
cd "$(dirname "$0")/../.."
npx @tailwindcss/cli -i page/admin/preview.css -o page/admin/preview.built.css --minify
npx esbuild page/admin/main.ts --bundle --minify --format=iife --jsx=automatic --loader:.css=text \
  --alias:@=./real-ui/src --alias:@radix-ui/react-portal=./page/admin/portal-shim.tsx \
  --define:process.env.NODE_ENV='"production"' --outfile=page/admin/app.js --log-level=warning
npx esbuild page/admin/worker.ts --bundle --minify --format=iife --outfile=page/admin/worker.js --log-level=warning
