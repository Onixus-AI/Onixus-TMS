#!/bin/bash
set -e
vercel --prod
vercel env add SUPABASE_URL
vercel env add SUPABASE_ANON_KEY
vercel env add FMCSA_API_KEY
vercel env add EMODAL_API_KEY
echo "Vercel deployed"
