#!/bin/bash
set -e
# The web app only needs the API's public URL; every secret stays on the API.
vercel env add VITE_API_URL
vercel --prod
echo "Vercel deployed"
