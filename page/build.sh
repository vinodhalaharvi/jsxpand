#!/bin/sh
# Builds the preview page: Tailwind for the component previews, then one bundle.
set -e
cd "$(dirname "$0")/.."
npx tailwindcss -c tailwind.config.cjs -i page/preview.css -o page/preview.built.css --minify
npx esbuild page/main.ts --bundle --minify --format=iife --jsx=automatic --loader:.css=text --define:process.env.NODE_ENV='"production"' --outfile=page/app.js --log-level=warning
