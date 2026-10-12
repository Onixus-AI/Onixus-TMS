#!/bin/bash
set -e
echo "Linking Supabase..."
supabase link --project-ref $SUPABASE_PROJECT_REF
supabase db push
supabase gen types typescript --linked > packages/providers/src/db/database.types.ts
echo "Supabase ready"
