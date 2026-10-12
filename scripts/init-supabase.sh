#!/bin/bash
set -e
echo "Linking Supabase..."
supabase link --project-ref $SUPABASE_PROJECT_REF
supabase db push
supabase functions deploy fmcsa-monitor
supabase functions deploy port-webhook
supabase gen types typescript --linked > packages/providers/src/db/database.types.ts
echo "Supabase ready"
