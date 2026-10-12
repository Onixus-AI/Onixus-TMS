#!/bin/bash
set -e
echo "Creating GitHub repo onixus-drayage-os"
gh repo create onixus-drayage-os --private --source=. --remote=origin --push
echo "Repo created + pushed"
